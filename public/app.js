/* CF 进销存 前端（Vue 3 全局构建，无构建步骤） */
const { createApp } = Vue

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || '请求失败（' + res.status + '）')
  return data
}

const pad = (n) => String(n).padStart(2, '0')
function dstr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) }
function todayStr() { return dstr(new Date()) }
function monthStartStr() { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-01' }
function daysAgoStr(n) { const d = new Date(); d.setDate(d.getDate() - n); return dstr(d) }
// 本地日期 → UTC ISO 范围（含 from，不含 to）
function rangeISO(from, to) {
  const f = new Date(from + 'T00:00:00')
  const t = new Date(to + 'T00:00:00')
  t.setDate(t.getDate() + 1)
  return { from: f.toISOString(), to: t.toISOString() }
}
function exportCSV(filename, headers, rows) {
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
  }
  const lines = [headers.join(','), ...rows.map((r) => r.map(esc).join(','))]
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

const NAV = [
  { key: 'dashboard', label: '数据概览', icon: '◉' },
  { key: 'products', label: '商品管理', icon: '⊞' },
  { key: 'purchase', label: '采购入库', icon: '↓' },
  { key: 'sales', label: '销售出库', icon: '↑' },
  { key: 'repairs', label: '维修管理', icon: '⚒\uFE0E' },
  { key: 'stock', label: '库存查询', icon: '▤' },
  { key: 'funds', label: '资金账户', icon: '¥' },
  { key: 'reports', label: '报表中心', icon: '▦' },
  { key: 'parties', label: '往来单位', icon: '☰' },
  { key: 'settings', label: '系统设置', icon: '⚙' }
]

const REPAIR_STATUS_LABEL = { repairing: '维修中', done: '已完成', closed: '已取机' }

const FUND_TYPE_LABEL = {
  receipt: '收款', payment: '付款', income: '其他收入', expense: '其他支出',
  sale_paid: '销货收款', purchase_paid: '购货付款', repair_paid: '维修收款',
  sale_return: '销货退款', purchase_return: '退货收回',
}

const app = createApp({
  data() {    return {
      nav: NAV,
      view: 'dashboard',
      loggedIn: false,
      hideBalance: localStorage.getItem('erp_hide_balance') !== '0',  // 概览账户总余额默认隐藏，记忆用户选择
      authReady: false,   // 会话检查完成前显示加载页，避免刷新时闪登录框
      booted: false,
      loginUser: '',
      loginPwd: '',
      // 用户管理
      currentUser: { id: 0, username: 'admin', name: '管理员', role: 'admin', permissions: [] },
      userList: [],
      userModal: null, // { id, username, name, password, role, status, permissions, phone, note }
      pwdModal: { oldPassword: '', newUsername: '', newPassword: '', confirmPassword: '' },
      clearInputText: '',
      backupLoading: false,
      loginErr: '',
      toastMsg: '', toastType: 'ok',

      products: [],
      parties: [],
      accounts: [],
      purchases: [],
      sales: [],
      // 维修单
      repairs: [],
      repairStatusFilter: '',
      repairForm: null,
      adjustments: [],
      funds: [],
      moves: [],
      movesProduct: '',
      dash: null,
      dashFrom: monthStartStr(),
      dashTo: todayStr(),
      // 采购/销售记录筛选（默认当月；留空显示全部）
      ordFrom: monthStartStr(),
      ordTo: todayStr(),

      // 商品
      prodSearch: '',
      prodCategory: '',
      showArchived: false,
      prodModal: null,
      adjustModal: null, // { product, qty, reason }

      // 订单
      purchaseForm: { supplier_id: '', customer_id: '', name_free: '', note: '', discount: '', paid: '', account_id: '', items: [{ product_id: '', qty: '', price: '' }] },
      saleForm: { supplier_id: '', customer_id: '', name_free: '', note: '', discount: '', paid: '', account_id: '', items: [{ product_id: '', qty: '', price: '' }] },
      orderDetail: null,
      orderDetailType: 'purchase',
      orderEdit: null,
      returnModal: null, // { type:'sales'|'purchases', source, items, refund_way, account_id }
      submitting: false,

      // 打印预览文档数据（声明在 data 里成为 Vue 响应式属性）
      printDoc: null,

      // 公司与系统配置（默认通用占位符，由用户在系统设置里自定义或导入备份）
      company: {
        app_title: 'Cloud ERP 进销存',
        company_name: '我的企业/店铺',
        company_phone: '',
        company_address: '',
        company_contact: '',
        print_footer_note: '诚信服务 · 品质保证',
      },

      // 资金
      fundModal: null,   // { type, party_id, account_id, amount, note }
      accountModal: null,

      // WebDAV 配置
      webdav: {
        enabled: false,
        url: '',
        username: '',
        password: '',
        remote_dir: '/erp-backups',
        keep_days: 10,
        last_backup_at: '',
        last_status: '',
        last_error: '',
      },
      webdavTesting: false,
      webdavRemoteList: [],   // WebDAV 远程备份文件列表
      webdavListLoading: false,
      webdavRestoring: false,

      // 往来单位
      partyTab: 'supplier',
      partyModal: null,

      // 报表
      repFrom: monthStartStr(),
      repTo: todayStr(),
      profit: null,
      summary: null,
      fundsRep: null,
      fundsDetail: null,     // 单笔收支详情/编辑弹窗
      fundsForm: { type: 'income', party_id: '', account_id: '', amount: '', note: '', date: '' },
      fundsDayFilter: null,  // 按日汇总点击日期 → 筛选当天明细
      sec: { profit: true, summary: false, debt: false, funds: false },
      repLoading: false,
    }
  },
  computed: {
    productMap() {
      const m = {}
      for (const p of this.products) m[p.id] = p
      return m
    },
    activeProducts() {
      return this.products.filter((p) => !p.archived)
    },
    purchasableProducts() {
      return this.activeProducts.filter((p) => !p.no_stock)
    },
    categories() {
      const set = new Set()
      for (const p of this.products) if (p.category) set.add(p.category)
      return [...set]
    },
    nextSku() {
      let max = 0
      for (const p of this.products) {
        const s = String(p.sku ?? '').trim()
        if (/^\d{1,9}$/.test(s)) max = Math.max(max, parseInt(s, 10))
      }
      return String(max + 1)
    },
    filteredProducts() {
      const kw = this.prodSearch.trim().toLowerCase()
      return this.products.filter((p) => {
        if (!this.showArchived && p.archived) return false
        if (this.prodCategory && p.category !== this.prodCategory) return false
        if (!kw) return true
        return p.name.toLowerCase().includes(kw) || (p.sku || '').toLowerCase().includes(kw) || (p.barcode || '').toLowerCase().includes(kw)
      })
    },
    suppliers() { return this.parties.filter((p) => p.type === 'supplier') },
    customers() { return this.parties.filter((p) => p.type === 'customer') },
    customerDebtTotal() { return this.customers.reduce((s, p) => s + (p.debt || 0), 0) },
    supplierDebtTotal() { return this.suppliers.reduce((s, p) => s + (p.debt || 0), 0) },
    purchaseTotal() { return this.orderTotal(this.purchaseForm) },
    saleTotal() { return this.orderTotal(this.saleForm) },
    purchaseNet() { return Math.max(0, this.purchaseTotal - Number(this.purchaseForm.discount || 0)) },
    saleNet() { return Math.max(0, this.saleTotal - Number(this.saleForm.discount || 0)) },
    saleProfit() {
      return this.saleForm.items.reduce((s, it) => {
        if (it.manual) return s + (Number(it.price) - Number(it.cost || 0)) * Number(it.qty || 0)
        const p = this.productMap[it.product_id]
        return s + (p ? (Number(it.price) - p.avg_cost) * Number(it.qty || 0) : 0)
      }, 0)
    },
    fundsListFiltered() {
      if (!this.fundsRep || !Array.isArray(this.fundsRep.list)) return []
      return this.fundsRep.list.filter(
        (x) => !this.fundsDayFilter || String(x.created_at).slice(0, 10) === this.fundsDayFilter
      )
    },
    stockValue() {
      return this.products.reduce((s, p) => s + p.stock * p.avg_cost, 0)
    },
    accountTotal() { return this.accounts.reduce((s, a) => s + (a.balance || 0), 0) },
  },
  methods: {
    // ===== 权限判断 =====
    hasPerm(key) {
      if (!this.currentUser) return false
      if (this.currentUser.role === 'admin') return true
      const perms = this.currentUser.permissions || []
      return perms.includes(key)
    },
    navVisible(item) {
      if (item.key === 'settings' && this.currentUser?.role !== 'admin') return false
      return this.hasPerm(item.key)
    },
    toggleBalance() {
      this.hideBalance = !this.hideBalance
      localStorage.setItem('erp_hide_balance', this.hideBalance ? '1' : '0')
    },
    blankOrder() {
      return { supplier_id: '', customer_id: '', name_free: '', note: '', discount: '', paid: '', account_id: '', date: '', items: [{ product_id: '', qty: '', price: '' }] }
    },
    money(n) { return '¥' + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2) },
    qfmt(n) {
      const x = Number(n) || 0
      return Number.isInteger(x) ? String(x) : String(+x.toFixed(3))
    },
    dt(s) {
      if (!s) return ''
      return new Date(s).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    },
    fmtSize(bytes) {
      if (!bytes && bytes !== 0) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / 1024 / 1024).toFixed(2) + ' MB'
    },
    fundLabel(t) { return FUND_TYPE_LABEL[t] || t },
    // 欠款展示：正数=欠款，负数=预收（客户多付/我方多付）
    debtLabel(p) {
      const d = Number(p.debt || 0)
      if (d > 0) return '欠 ' + this.money(d)
      if (d < 0) return '预收 ' + this.money(-d)
      return ''
    },
    toast(msg, type = 'ok') {
      this.toastMsg = msg
      this.toastType = type
      clearTimeout(this._tt)
      this._tt = setTimeout(() => (this.toastMsg = ''), 2600)
    },

    // ===== 路由 =====
    go(key) { location.hash = '#/' + key },
    onHash() {
      const key = (location.hash.replace(/^#\//, '') || 'dashboard').split('?')[0]
      this.view = NAV.some((n) => n.key === key) ? key : 'dashboard'
      if (this.loggedIn) this.loadView()
    },

    // ===== 登录 =====
    async login() {
      this.loginErr = ''
      try {
        const res = await api('/login', {
          method: 'POST',
          body: { username: this.loginUser, password: this.loginPwd },
        })
        this.loggedIn = true
        this.currentUser = res.user || { id: 1, username: this.loginUser || 'admin', name: '管理员', role: 'admin', permissions: [] }
        this.loginPwd = ''
        this.loadView()
      } catch (e) {
        this.loginErr = e.message
      }
    },
    async logout() {
      await api('/logout', { method: 'POST' }).catch(() => {})
      this.loggedIn = false
      this.currentUser = null
    },

    // ===== 用户管理 =====
    openUserModal(u) {
      if (u) {
        this.userModal = {
          id: u.id,
          username: u.username,
          name: u.name || '',
          password: '', // 留空不修改
          role: u.role || 'staff',
          status: u.status !== undefined ? u.status : 1,
          permissions: Array.isArray(u.permissions) ? [...u.permissions] : [],
          phone: u.phone || '',
          note: u.note || '',
        }
      } else {
        this.userModal = {
          id: null,
          username: '',
          name: '',
          password: '',
          role: 'staff',
          status: 1,
          permissions: ['products', 'sales', 'stock'], // 默认常用业务权限
          phone: '',
          note: '',
        }
      }
    },
    togglePerm(key) {
      if (!this.userModal) return
      const arr = this.userModal.permissions
      const idx = arr.indexOf(key)
      if (idx >= 0) arr.splice(idx, 1)
      else arr.push(key)
    },
    async saveUser() {
      const m = this.userModal
      if (!m.username.trim()) return this.toast('请填写用户名', 'err')
      if (!m.id && (!m.password || m.password.length < 4)) return this.toast('新用户密码至少 4 位', 'err')
      try {
        if (m.id) {
          const body = {
            name: m.name,
            role: m.role,
            status: m.status,
            permissions: m.role === 'admin' ? [] : m.permissions,
            phone: m.phone,
            note: m.note,
          }
          if (m.password && m.password.trim().length >= 4) {
            body.newPassword = m.password.trim()
          }
          await api('/users/' + m.id, { method: 'PUT', body })
          this.toast('用户信息已保存')
        } else {
          await api('/users', {
            method: 'POST',
            body: {
              username: m.username,
              name: m.name,
              password: m.password,
              role: m.role,
              permissions: m.role === 'admin' ? [] : m.permissions,
              phone: m.phone,
              note: m.note,
            },
          })
          this.toast('用户添加成功')
        }
        this.userModal = null
        if (this.currentUser?.role === 'admin') {
          this.userList = await api('/users')
        }
      } catch (e) {
        this.toast(e.message, 'err')
      }
    },
    async delUser(u) {
      if (!confirm(`确定删除用户「${u.name || u.username}」？`)) return
      try {
        await api('/users/' + u.id, { method: 'DELETE' })
        this.toast('用户已删除')
        this.userList = await api('/users')
      } catch (e) {
        this.toast(e.message, 'err')
      }
    },
    roleLabel(role) {
      if (role === 'admin') return '超级管理员'
      if (role === 'sales') return '销售/收银员'
      return '普通员工 (次级)'
    },

    // ===== 系统设置加载与保存 =====
    async loadSettings() {
      try {
        const reqs = [
          api('/settings/webdav'),
          api('/settings/company').catch(() => null),
        ]
        if (this.currentUser?.role === 'admin') {
          reqs.push(api('/users').catch(() => []))
        }
        const [wRes, cRes, uList] = await Promise.all(reqs)
        this.webdav = {
          enabled: !!wRes.enabled,
          url: wRes.url || '',
          username: wRes.username || '',
          password: wRes.password || '',
          remote_dir: wRes.remote_dir || '/erp-backups',
          keep_days: wRes.keep_days || 10,
          last_backup_at: wRes.last_backup_at || '',
          last_status: wRes.last_status || '',
          last_error: wRes.last_error || '',
        }
        if (cRes) {
          this.company = { ...this.company, ...cRes }
          document.title = this.company.app_title || 'Cloud ERP 进销存'
        }
        if (uList) {
          this.userList = uList
        }
        // 已配置 WebDAV 地址时，自动拉取远程备份列表
        if (wRes.url) {
          this.loadWebDAVList()
        }
      } catch (e) {
        // 忽略静默失败
      }
    },
    async saveCompanyConfig() {
      try {
        await api('/settings/company', {
          method: 'POST',
          body: this.company,
        })
        document.title = this.company.app_title || 'Cloud ERP 进销存'
        this.toast('公司与系统信息已保存')
      } catch (e) {
        this.toast(e.message, 'err')
      }
    },
    async saveWebDAVConfig() {
      try {
        await api('/settings/webdav', {
          method: 'POST',
          body: {
            enabled: this.webdav.enabled,
            url: this.webdav.url,
            username: this.webdav.username,
            password: this.webdav.password,
            remote_dir: this.webdav.remote_dir,
            keep_days: this.webdav.keep_days,
          },
        })
        this.toast('WebDAV 配置已保存')
        await this.loadSettings()
      } catch (e) {
        this.toast(e.message, 'err')
      }
    },
    async testAndBackupWebDAV() {
      if (!this.webdav.url) return this.toast('请先输入 WebDAV 服务器地址', 'err')
      this.webdavTesting = true
      try {
        // 先保存当前填写的配置
        await api('/settings/webdav', {
          method: 'POST',
          body: {
            enabled: this.webdav.enabled,
            url: this.webdav.url,
            username: this.webdav.username,
            password: this.webdav.password,
            remote_dir: this.webdav.remote_dir,
            keep_days: this.webdav.keep_days,
          },
        })
        const res = await api('/settings/webdav/test', { method: 'POST' })
        this.toast(`备份并上传成功：${res.filename}`)
        await this.loadSettings()
      } catch (e) {
        this.toast(`测试失败：${e.message}`, 'err')
        await this.loadSettings()
      } finally {
        this.webdavTesting = false
      }
    },
    // 拉取 WebDAV 远程备份文件列表
    async loadWebDAVList() {
      if (!this.webdav.url) return
      this.webdavListLoading = true
      try {
        const res = await api('/settings/webdav/list', { method: 'POST' })
        this.webdavRemoteList = Array.isArray(res.files) ? res.files : []
        if (res.error) this.toast(res.error, 'err')
        // 调试：列表为空时打印原始响应，便于排查服务器格式差异
        if (res.xml_sample && !this.webdavRemoteList.length) {
          console.log('[webdav] list empty. resp_count=' + res.resp_count + ' xml_sample=', res.xml_sample)
        }
      } catch (e) {
        this.webdavRemoteList = []
        this.toast('无法获取远程备份列表：' + e.message, 'err')
      } finally {
        this.webdavListLoading = false
      }
    },
    // 从 WebDAV 远程备份恢复
    async restoreFromWebDAV(file) {
      const name = typeof file === 'string' ? file : file?.name
      if (!name) return
      if (!confirm(`确定要从远程备份「${name}」恢复数据吗？\n\n警告：当前所有数据将被该备份文件完全覆盖！`)) return
      if (!confirm('再次确认：还原操作不可逆，原有数据将全部丢失，是否立即执行？')) return
      this.webdavRestoring = true
      try {
        const res = await api('/settings/webdav/restore', {
          method: 'POST',
          body: { filename: name },
        })
        this.toast(`已从远程备份恢复成功：${res.filename || name}`)
        await this.loadView()
        await this.loadWebDAVList()
      } catch (e) {
        this.toast('恢复失败：' + e.message, 'err')
      } finally {
        this.webdavRestoring = false
      }
    },
    async downloadBackup() {
      this.backupLoading = true
      try {
        const res = await fetch('/api/backup/export')
        if (!res.ok) throw new Error('导出备份失败')
        const blob = await res.blob()
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `全量备份_${todayStr()}.json`
        a.click()
        URL.revokeObjectURL(a.href)
        this.toast('备份文件已下载')
      } catch (e) {
        this.toast(e.message, 'err')
      } finally {
        this.backupLoading = false
      }
    },
    triggerImportFile() {
      const input = document.getElementById('backup-file-input')
      if (input) input.click()
    },
    async onBackupFileSelected(e) {
      const file = e.target.files?.[0]
      if (!file) return
      // 第一次确认
      if (!confirm(`确定要从文件「${file.name}」还原数据吗？\n\n警告：当前所有数据将被该备份文件完全覆盖！`)) {
        e.target.value = ''
        return
      }
      // 第二次确认
      if (!confirm('再次确认：还原操作不可逆，原有的现有数据将全部丢失，是否立即执行？')) {
        e.target.value = ''
        return
      }

      this.backupLoading = true
      try {
        const text = await file.text()
        const json = JSON.parse(text)
        const res = await api('/backup/import', { method: 'POST', body: json })
        this.toast('数据已成功还原并重算！')
        await this.loadView()
      } catch (err) {
        this.toast('还原失败：' + err.message, 'err')
      } finally {
        this.backupLoading = false
        e.target.value = ''
      }
    },
    async clearAllData() {
      // 第一次弹窗确认
      if (!confirm('【极其危险】确定要清空全部业务数据吗？\n\n包含所有商品、客户、供应商、订单、流水！\n操作后无法撤销！')) {
        return
      }
      // 第二次输入口令确认
      const promptText = window.prompt('【二次确认】请输入「确认清空全部数据」以执行清空：')
      if (promptText !== '确认清空全部数据') {
        if (promptText !== null) this.toast('口令错误，已取消操作', 'err')
        return
      }

      this.backupLoading = true
      try {
        await api('/backup/clear-all', {
          method: 'POST',
          body: { confirmation: '确认清空全部数据' },
        })
        this.toast('全部业务数据已清空')
        await this.loadView()
      } catch (e) {
        this.toast(e.message, 'err')
      } finally {
        this.backupLoading = false
      }
    },

    // ===== 数据加载 =====
    async loadView() {
      const v = this.view
      try {
        if (v === 'dashboard') await this.loadDashboard()
        else if (v === 'products') this.products = await api('/products')
        else if (v === 'purchase') await this.loadOrders('purchase')
        else if (v === 'sales') await this.loadOrders('sales')
        else if (v === 'repairs') await this.loadRepairs()
        else if (v === 'stock') {
          ;[this.products, this.adjustments] = await Promise.all([api('/products'), api('/adjustments')])
        } else if (v === 'funds') await this.loadFunds()
        else if (v === 'reports') await this.loadReports()
        else if (v === 'parties') this.parties = await api('/parties')
        else if (v === 'settings') await this.loadSettings()
      } catch (e) {
        if (String(e.message).includes('未登录')) { this.loggedIn = false; return }
        this.toast(e.message, 'err')
      }
    },
    async loadDashboard() {
      const r = rangeISO(this.dashFrom || monthStartStr(), this.dashTo || todayStr())
      this.dash = await api('/dashboard?from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to))
    },
    setDashRange(kind) {
      this.dashFrom = kind === 'today' ? todayStr() : kind === '7d' ? daysAgoStr(6) : monthStartStr()
      this.dashTo = todayStr()
      this.loadDashboard()
    },
    async loadOrders(kind) {
      const reqs = [api('/products'), api('/parties'), api('/accounts')]
      let qs = ''
      if (this.ordFrom && this.ordTo) {
        const r = rangeISO(this.ordFrom, this.ordTo)
        qs = `?from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`
      }
      if (kind === 'purchase') reqs.push(api('/purchases' + qs))
      else reqs.push(api('/sales' + qs))
      const [products, parties, accounts, orders] = await Promise.all(reqs)
      this.products = products
      this.parties = parties
      this.accounts = accounts
      if (kind === 'purchase') this.purchases = orders
      else this.sales = orders
    },
    // 采购/销售记录快捷区间：month 当月 / prev 上月 / all 全部
    setOrdRange(mode) {
      if (mode === 'all') {
        this.ordFrom = ''
        this.ordTo = ''
      } else if (mode === 'prev') {
        const d = new Date()
        d.setDate(1)
        d.setMonth(d.getMonth() - 1)
        this.ordFrom = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-01'
        this.ordTo = dstr(new Date(d.getFullYear(), d.getMonth() + 1, 0))
      } else {
        this.ordFrom = monthStartStr()
        this.ordTo = todayStr()
      }
      this.ordFilterChanged()
    },
    ordFilterChanged() {
      this.loadOrders(this.view === 'sales' ? 'sales' : 'purchase')
    },
    // ===== 维修单 =====
    repairStatusLabel(s) { return REPAIR_STATUS_LABEL[s] || s },
    async loadRepairs() {
      const reqs = [api('/products'), api('/parties'), api('/accounts')]
      let qs = ''
      if (this.ordFrom && this.ordTo) {
        const r = rangeISO(this.ordFrom, this.ordTo)
        qs = `?from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`
      }
      if (this.repairStatusFilter) qs += (qs ? '&' : '?') + 'status=' + this.repairStatusFilter
      const [products, parties, accounts, list] = await Promise.all([...reqs, api('/repairs' + qs)])
      this.products = products
      this.parties = parties
      this.accounts = accounts
      this.repairs = list
    },
    setRepairStatusFilter(s) {
      this.repairStatusFilter = s
      this.loadRepairs()
    },
    blankRepair() {
      return { id: null, customer_id: '', name_free: '', phone: '', device: '', fault: '', solution: '', fee: '', discount: '', paid: '', account_id: '', note: '', date: '', items: [{ product_id: '', qty: '', price: '' }] }
    },
    openRepairModal(existing) {
      if (existing) {
        api('/repairs/' + existing.id).then((full) => {
          this.repairForm = {
            id: full.id,
            customer_id: full.customer_id || '',
            name_free: full.customer_id ? '' : (full.customer_name || ''),
            phone: full.phone || '',
            device: full.device || '',
            fault: full.fault || '',
            solution: full.solution || '',
            fee: full.fee || '',
            discount: full.discount || '',
            paid: full.paid || '',
            account_id: full.account_id || '',
            note: full.note || '',
            date: dstr(new Date(full.created_at)),
            items: (full.items || []).length
              ? full.items.map((it) => it.product_id
                  ? { product_id: it.product_id, qty: it.qty, price: it.unit_price }
                  : { manual: true, name: it.product_name || it.name || '', qty: it.qty, price: it.unit_price, cost: it.unit_cost || 0 })
              : [{ product_id: '', qty: '', price: '' }],
          }
        }).catch((e) => this.toast(e.message, 'err'))
      } else {
        this.repairForm = this.blankRepair()
      }
    },
    repairAddItem() {
      if (this.repairForm) this.repairForm.items.push({ product_id: '', qty: '', price: '' })
    },
    repairAddManualItem() {
      if (this.repairForm) this.repairForm.items.push({ manual: true, name: '', qty: '', price: '', cost: '' })
    },
    repairRemoveItem(i) {
      if (this.repairForm && this.repairForm.items.length > 1) this.repairForm.items.splice(i, 1)
    },
    onRepairProductChange(row, id) {
      const p = this.productMap[id !== undefined ? id : row.product_id]
      if (p) row.price = p.sale_price
    },
    repairPartsTotal(form) {
      return form.items.reduce((s, it) => s + Number(it.qty || 0) * Number(it.price || 0), 0)
    },
    repairNet(form) {
      return Number(form.fee || 0) + this.repairPartsTotal(form) - Number(form.discount || 0)
    },
    repairCustomerName(form) {
      const c = this.customers.find((x) => x.id === Number(form.customer_id))
      return c ? c.name : (form.name_free || '').trim()
    },
    async submitRepair() {
      const form = this.repairForm
      if (!form) return
      const hasPart = form.items.some((it) => (it.manual ? (it.name || '').trim() : it.product_id) && Number(it.qty) > 0)
      if (!form.fee && !hasPart) {
        return this.toast('请填写维修费或至少一条配件明细', 'err')
      }
      if (Number(form.paid || 0) > 0 && !form.account_id) return this.toast('本次收款需要选择结算账户', 'err')
      const validManual = form.items.filter((it) => it.manual && (it.name || '').trim() && Number(it.qty) > 0)
      if (validManual.some((it) => Number(it.price) < 0)) return this.toast('配件单价不能为负数', 'err')
      if (validManual.some((it) => Number(it.cost) < 0)) return this.toast('配件成本不能为负数', 'err')
      const items = form.items
        .filter((it) => it.product_id && Number(it.qty) > 0)
        .map((it) => ({ product_id: Number(it.product_id), qty: Number(it.qty), unit_price: Number(it.price) || 0 }))
        .concat(validManual.map((it) => ({ product_id: 0, name: it.name.trim(), qty: Number(it.qty), unit_price: Number(it.price) || 0, unit_cost: Number(it.cost) || 0 })))
      const body = {
        customer_id: form.customer_id || null,
        customer_name: this.repairCustomerName(form),
        phone: form.phone,
        device: form.device,
        fault: form.fault,
        solution: form.solution,
        fee: Number(form.fee || 0),
        discount: Number(form.discount || 0),
        paid: Number(form.paid || 0),
        account_id: form.account_id || null,
        note: form.note,
        doc_date: form.date || '',
        items,
      }
      this.submitting = true
      try {
        if (form.id) {
          await api('/repairs/' + form.id, { method: 'PUT', body })
          this.toast('维修单已更新')
        } else {
          await api('/repairs', { method: 'POST', body })
          this.toast('维修单已登记')
        }
        this.repairForm = null
        await this.loadRepairs()
      } catch (e) {
        this.toast(e.message, 'err')
      } finally {
        this.submitting = false
      }
    },
    async setRepairStatus(r, status) {
      const label = REPAIR_STATUS_LABEL[status] || status
      if (!confirm(`确定将维修单 #${r.id}（${r.customer_name || '散客'}）标记为「${label}」吗？`)) return
      try {
        await api(`/repairs/${r.id}/status`, { method: 'POST', body: { status } })
        this.toast(`已标记为「${label}」`)
        await this.loadRepairs()
      } catch (e) {
        this.toast(e.message, 'err')
      }
    },
    async delRepair(id) {
      if (!confirm(`确定删除维修单 #${id} 吗？已扣减的配件库存将自动回补。`)) return
      try {
        await api('/repairs/' + id, { method: 'DELETE' })
        this.toast('维修单已删除')
        await this.loadRepairs()
      } catch (e) {
        this.toast(e.message, 'err')
      }
    },
    async printRepair(r) {
      try {
        const d = await api('/repairs/' + r.id)
        const rows = (d.items || []).map((it) => [it.product_name || ('#' + it.product_id), it.qty, this.money(it.unit_price), this.money(it.qty * it.unit_price)])
        this.printDoc = {
          title: '维修单',
          no: 'No.' + String(d.id).padStart(5, '0'),
          meta: [
            ['日期', this.dt(d.created_at)],
            ['客户', d.customer_name || '散客'],
            ['电话', d.phone || '—'],
            ['设备型号', d.device || '—'],
            ['故障描述', d.fault || '—'],
            ['状态', this.repairStatusLabel(d.status)],
          ],
          remarkLabel: '维修说明',
          remark: d.solution || '',
          table: rows.length ? { head: ['配件项目', '数量', '单价', '小计'], rows } : null,
          totals: [
            ['维修费', this.money(d.fee)],
            ['配件费', this.money(d.parts_total)],
            ['优惠', d.discount ? '-' + this.money(d.discount) : '—'],
            ['应收合计', this.money(d.fee + d.parts_total - d.discount)],
            ['已收', this.money(d.paid)],
            ['欠款', this.money(d.fee + d.parts_total - d.discount - d.paid)],
          ],
          sign: '客户签字',
          footer: this.company.print_footer_note || '',
        }
      } catch (e) {
        this.toast(e.message, 'err')
      }
    },
    async loadFunds() {
      const [accounts, funds, parties] = await Promise.all([api('/accounts'), api('/funds'), api('/parties')])
      this.accounts = accounts
      this.funds = funds
      this.parties = parties
    },
    async loadMoves() {
      const q = this.movesProduct ? '?product_id=' + this.movesProduct : ''
      this.moves = await api('/stock/moves' + q)
    },
    async loadReports() {
      this.repLoading = true
      try {
        const r = rangeISO(this.repFrom, this.repTo)
        const q = '?from=' + encodeURIComponent(r.from) + '&to=' + encodeURIComponent(r.to)
        const [profit, summary, fundsRep, parties] = await Promise.all([
          api('/reports/profit' + q),
          api('/reports/summary' + q),
          api('/reports/otherfunds' + q),
          api('/parties'),
        ])
        this.profit = profit
        this.summary = summary
        this.fundsRep = fundsRep
        this.parties = parties
        this.accounts = await api('/accounts')
        this.fundsDayFilter = null
        this.fundsDetail = null
      } finally {
        this.repLoading = false
      }
    },
    openFundsDetail(x) {
      this.fundsDetail = x
      if (['receipt', 'payment', 'income', 'expense'].includes(x.type)) {
        this.fundsForm = {
          type: x.type,
          party_id: x.party_id || '',
          account_id: x.account_id || '',
          amount: Number(x.amount),
          note: x.note || '',
          date: dstr(new Date(x.created_at)),
        }
      }
    },
    fundsEditable(x) {
      return ['receipt', 'payment', 'income', 'expense'].includes(x.type)
    },
    async saveFundsRow() {
      const f = this.fundsForm
      if (!Number(f.amount) || Number(f.amount) <= 0) return this.toast('请填写大于 0 的金额', 'err')
      if (!f.account_id) return this.toast('请选择结算账户', 'err')
      if ((f.type === 'receipt' || f.type === 'payment') && !f.party_id) return this.toast('请选择往来单位', 'err')
      try {
        await api('/funds/' + this.fundsDetail.id, {
          method: 'PUT',
          body: { type: f.type, party_id: f.party_id || null, account_id: Number(f.account_id), amount: Number(f.amount), note: f.note, doc_date: f.date || '' },
        })
        this.fundsDetail = null
        this.toast('已修改')
        if (this.view === 'funds') await this.loadFunds()
        else await this.loadReports()
      } catch (e) { this.toast(e.message, 'err') }
    },
    async delFundsRow() {
      if (!confirm('确定删除这笔流水？账户余额与欠款将自动重算。')) return
      try {
        await api('/funds/' + this.fundsDetail.id, { method: 'DELETE' })
        this.fundsDetail = null
        this.toast('已删除')
        if (this.view === 'funds') await this.loadFunds()
        else await this.loadReports()
      } catch (e) { this.toast(e.message, 'err') }
    },
    csvFunds() {
      const f = this.fundsRep
      if (!f) return
      exportCSV(`其他收支_${this.repFrom}_${this.repTo}.csv`, ['时间', '类型', '往来单位', '账户', '金额', '备注'],
        f.list.map((x) => [dt(x.created_at), x.type === 'income' ? '收入' : '支出', x.party_name || '—', x.account_name || '—', x.amount, x.note]))
    },
    moveLabel(m) {
      if (m.type === 'purchase') return m.kind === 'return' ? '采购退货' : '采购入库'
      if (m.type === 'sale') return m.kind === 'return' ? '销售退货' : '销售出库'
      return '盘点调整'
    },
    moveSigned(m) {
      const SIGN = { 'purchase:normal': 1, 'purchase:return': -1, 'sale:normal': -1, 'sale:return': 1, 'adjust:': 1 }
      return (SIGN[m.type + ':' + (m.kind || '')] || 1) * Number(m.qty || 0)
    },
    fundSigned(m) {
      const plus = ['receipt', 'income', 'sale_paid', 'repair_paid', 'purchase_return'].includes(m.type)
      return (plus ? 1 : -1) * Number(m.amount || 0)
    },

    // ===== 商品 =====
    openProdModal(p) {
      this.prodModal = p
        ? { id: p.id, name: p.name, sku: p.sku, barcode: p.barcode, category: p.category, unit: p.unit, sale_price: p.sale_price, low_stock: p.low_stock, archived: !!p.archived, no_stock: !!p.no_stock, avg_cost: p.avg_cost, cost_manual: !!p.cost_manual, _origAvg: Number(p.avg_cost), _origManual: !!p.cost_manual }
        : { id: null, name: '', sku: this.nextSku, barcode: '', category: '', unit: '件', initial_stock: '', initial_cost: '', sale_price: '', low_stock: '', archived: false, no_stock: false, avg_cost: 0, cost_manual: false, _origAvg: 0, _origManual: false }
    },
    restoreAutoCost() {
      const m = this.prodModal
      if (!m) return
      m.cost_manual = false
      m._restoring = true
      this.toast('保存后将按采购流水自动重算该商品成本')
    },
    async saveProduct() {
      const m = this.prodModal
      if (!m.name.trim()) return this.toast('请填写商品名称', 'err')
      try {
        if (m.id) {
          const body = { ...m }
          // 成本字段只在有实际变化时发送，避免每次编辑都锁定成本
          if (m._restoring) {
            body.cost_manual = false
            delete body.avg_cost
          } else if (Number(m.avg_cost) !== m._origAvg) {
            body.avg_cost = Number(m.avg_cost)
            body.cost_manual = true
          } else {
            delete body.avg_cost
            delete body.cost_manual
          }
          delete body._origAvg
          delete body._origManual
          delete body._restoring
          delete body._fromPicker
          await api('/products/' + m.id, { method: 'PUT', body })
          this.toast(body.cost_manual === false ? '已恢复自动成本' : '已保存')
        } else {
          const body = { ...m }
          delete body._fromPicker
          delete body._pickerRow
          const res = await api('/products', { method: 'POST', body })
          this.toast('商品已添加')
          // 从采购/销售表单发起的新增：自动填进发起的那一行
          if (m._fromPicker && res.id) {
            this.products = await api('/products')
            const row = (this[m._fromPicker] || {}).items?.[m._pickerRow]
            if (row) {
              row.product_id = res.id
              this.onProductChange(this[m._fromPicker], row)
            }
            this.prodModal = null
            return
          }
        }
        this.prodModal = null
        this.products = await api('/products')
      } catch (e) { this.toast(e.message, 'err') }
    },
    addNewProduct(formKey) {
      this.openProdModal(null)
      this.prodModal._fromPicker = formKey
      this.prodModal._pickerRow = this[formKey].items.length - 1
    },
    async delProduct(p) {
      if (!confirm(`确定删除商品「${p.name}」？`)) return
      try {
        await api('/products/' + p.id, { method: 'DELETE' })
        this.products = await api('/products')
        this.toast('已删除')
      } catch (e) { this.toast(e.message, 'err') }
    },
    openAdjust(p) { this.adjustModal = { product: p, qty: '', reason: '' } },
    async saveAdjust() {
      const m = this.adjustModal
      const qty = Number(m.qty)
      if (!Number.isFinite(qty) || qty === 0) return this.toast('请输入不为 0 的调整数量（盘盈为正、盘亏为负）', 'err')
      try {
        await api(`/products/${m.product.id}/adjustments`, { method: 'POST', body: { qty, reason: m.reason } })
        this.adjustModal = null
        ;[this.products, this.adjustments] = await Promise.all([api('/products'), api('/adjustments')])
        this.toast('库存已调整')
      } catch (e) { this.toast(e.message, 'err') }
    },

    // ===== 采购 / 销售 =====
    addRow(form) { form.items.push({ product_id: '', qty: '', price: '' }) },
    addManualRow(form) { form.items.push({ manual: true, name: '', qty: '', price: '', cost: '' }) },
    delRow(form, i) { form.items.splice(i, 1) },
    onProductChange(form, row, id) {
      const p = this.productMap[id !== undefined ? id : row.product_id]
      if (!p) return
      row.price = form === this.purchaseForm ? p.avg_cost : p.sale_price
    },
    orderTotal(form) {
      return form.items.reduce((s, it) => s + Number(it.qty || 0) * Number(it.price || 0), 0)
    },
    partyName(form) {
      if (form === this.purchaseForm) {
        const s = this.suppliers.find((x) => x.id === Number(form.supplier_id))
        return s ? s.name : (form.name_free || '').trim()
      }
      const s = this.customers.find((x) => x.id === Number(form.customer_id))
      return s ? s.name : (form.name_free || '').trim()
    },
    async submitOrder(kind) {
      const form = kind === 'purchase' ? this.purchaseForm : this.saleForm
      const validManual = kind === 'sales' ? form.items.filter((it) => it.manual && (it.name || '').trim() && Number(it.qty) > 0) : []
      if (validManual.some((it) => Number(it.price) < 0)) return this.toast('销售单价不能为负数', 'err')
      if (validManual.some((it) => Number(it.cost) < 0)) return this.toast('手填项成本不能为负数', 'err')
      const items = form.items
        .filter((it) => it.product_id && Number(it.qty) > 0)
        .map((it) => ({ product_id: Number(it.product_id), qty: Number(it.qty), unit_cost: Number(it.price) || 0, unit_price: Number(it.price) || 0 }))
        .concat(validManual.map((it) => ({ product_id: 0, name: it.name.trim(), qty: Number(it.qty), unit_price: Number(it.price) || 0, unit_cost: Number(it.cost) || 0 })))
      if (!items.length) return this.toast('请至少填写一条明细（选商品、填数量）', 'err')
      if (Number(form.paid || 0) > 0 && !form.account_id) return this.toast('本次收/付款需要选择结算账户', 'err')
      const base = { note: form.note, discount: Number(form.discount || 0), paid: Number(form.paid || 0), account_id: form.account_id || null, doc_date: form.date || '' }
      const body = kind === 'purchase'
        ? { ...base, supplier_id: form.supplier_id || null, supplier_name: this.partyName(form), items }
        : { ...base, customer_id: form.customer_id || null, customer_name: this.partyName(form), items }
      this.submitting = true
      try {
        await api('/' + (kind === 'purchase' ? 'purchases' : 'sales'), { method: 'POST', body })
        this.toast(kind === 'purchase' ? '入库成功' : '出库成功')
        this.purchaseForm = this.blankOrder()
        this.saleForm = this.blankOrder()
        await this.loadOrders(kind)
      } catch (e) {
        this.toast(e.message, 'err')
      } finally {
        this.submitting = false
      }
    },
    async viewOrder(kind, id) {
      this.orderDetailType = kind
      try {
        this.orderDetail = await api(`/${kind === 'purchase' ? 'purchases' : 'sales'}/${id}`)
      } catch (e) { this.toast(e.message, 'err') }
    },
    openReturn(kind, listId) {
      const src = (kind === 'sales' ? this.sales : this.purchases).find((x) => x.id === listId)
      if (!src) return
      this.returnModal = {
        kind,
        sourceId: src.id,
        partyId: kind === 'sales' ? src.customer_id : src.supplier_id,
        party: kind === 'sales' ? (src.customer_name || '散客') : (src.supplier_name || '—'),
        items: [],
        refund_way: 'debt',
        account_id: '',
        note: '退：' + (src.note || ''),
      }
      // 预填明细（异步拉取完整明细）
      api(`/${kind}/${src.id}`).then((full) => {
        if (!this.returnModal || this.returnModal.sourceId !== src.id) return
        this.returnModal.items = (full.items || []).map((it) => ({
          product_id: it.product_id,
          name: it.product_name,
          unit: it.unit,
          qty: it.qty,
          maxQty: it.qty,
          price: kind === 'sales' ? it.unit_price : it.unit_cost,
        }))
      }).catch((e) => this.toast(e.message, 'err'))
    },
    returnTotal() {
      const m = this.returnModal
      if (!m) return 0
      return m.items.reduce((s, it) => s + Number(it.qty || 0) * Number(it.price || 0), 0)
    },
    async submitReturn() {
      const m = this.returnModal
      const items = m.items
        .filter((it) => Number(it.qty) > 0)
        .map((it) => ({ product_id: it.product_id, qty: Number(it.qty), unit_price: Number(it.price) || 0, unit_cost: Number(it.price) || 0 }))
      if (!items.length) return this.toast('请填写退货数量', 'err')
      if (m.refund_way === 'account' && !m.account_id) return this.toast('退款到账户需要选择结算账户', 'err')
      this.submitting = true
      try {
        const body = m.kind === 'sales'
          ? { kind: 'return', customer_id: m.partyId || null, customer_name: m.party, note: m.note, refund_way: m.refund_way, account_id: m.account_id || null, items }
          : { kind: 'return', supplier_id: m.partyId || null, supplier_name: m.party, note: m.note, refund_way: m.refund_way, account_id: m.account_id || null, items }
        await api('/' + m.kind, { method: 'POST', body })
        this.toast('退货单已入账')
        this.returnModal = null
        await this.loadOrders(m.kind)
      } catch (e) {
        this.toast(e.message, 'err')
      } finally {
        this.submitting = false
      }
    },
    async delOrder(kind, id) {
      if (!confirm('确定删除该单据？库存与欠款将按流水自动重算。')) return
      try {
        await api(`/${kind === 'purchase' ? 'purchases' : 'sales'}/${id}`, { method: 'DELETE' })
        this.toast('已删除，已重算')
        await this.loadOrders(kind)
      } catch (e) { this.toast(e.message, 'err') }
    },
    openOrderEdit(kind, id) {
      const src = (kind === 'sales' ? this.sales : this.purchases).find(x => x.id === id)
      if (!src) return
      if (src.kind === 'return') return this.toast('退货单不支持修改', 'err')
      api(`/${kind}/${id}`).then(full => {
        this.orderEdit = {
          kind,
          id,
          party_id: kind === 'sales' ? full.customer_id : full.supplier_id,
          name_free: kind === 'sales' ? (full.customer_name || '') : (full.supplier_name || ''),
          note: full.note || '',
          discount: Number(full.discount) || 0,
          paid: Number(full.paid) || 0,
          account_id: full.account_id || '',
          date: dstr(new Date(full.created_at)),
          items: (full.items || []).map(it => it.product_id ? ({
            product_id: it.product_id,
            qty: Number(it.qty),
            price: Number(kind === 'sales' ? it.unit_price : it.unit_cost),
            origQty: Number(it.qty),
          }) : ({
            manual: true,
            name: it.product_name || it.name || '',
            qty: Number(it.qty),
            price: Number(it.unit_price),
            cost: Number(it.unit_cost) || 0,
            origQty: Number(it.qty),
          })),
        }
      }).catch(e => this.toast(e.message, 'err'))
    },
    addRowEdit() { this.orderEdit.items.push({ product_id: '', qty: '', price: '', origQty: 0 }) },
    delRowEdit(i) { this.orderEdit.items.splice(i, 1) },
    onProductChangeEdit(row, id) {
      const p = this.productMap[id !== undefined ? id : row.product_id]
      if (!p) return
      row.price = this.orderEdit.kind === 'purchase' ? p.avg_cost : p.sale_price
    },
    async saveOrderEdit() {
      const m = this.orderEdit
      const validManual = m.kind === 'sales' ? m.items.filter(it => it.manual && (it.name || '').trim() && Number(it.qty) > 0) : []
      const items = m.items
        .filter(it => it.product_id && Number(it.qty) > 0)
        .map(it => ({ product_id: Number(it.product_id), qty: Number(it.qty), unit_price: Number(it.price) || 0, unit_cost: Number(it.price) || 0 }))
        .concat(validManual.map(it => ({ product_id: 0, name: it.name.trim(), qty: Number(it.qty), unit_price: Number(it.price) || 0, unit_cost: Number(it.cost) || 0 })))
      if (!items.length) return this.toast('请至少填写一条明细', 'err')
      if (Number(m.paid || 0) > 0 && !m.account_id) return this.toast('本次收/付款需要选择结算账户', 'err')
      const pool = m.kind === 'sales' ? this.customers : this.suppliers
      const party = pool.find(x => x.id === Number(m.party_id))
      const name = party ? party.name : (m.name_free || '').trim()
      this.submitting = true
      try {
        const base = { note: m.note, discount: Number(m.discount || 0), paid: Number(m.paid || 0), account_id: m.account_id || null, doc_date: m.date || '' }
        const body = m.kind === 'sales'
          ? { ...base, customer_id: m.party_id || null, customer_name: name, items }
          : { ...base, supplier_id: m.party_id || null, supplier_name: name, items }
        await api('/' + m.kind + '/' + m.id, { method: 'PUT', body })
        this.toast('单据已修改，库存与欠款已重算')
        this.orderEdit = null
        await this.loadOrders(m.kind)
      } catch (e) {
        this.toast(e.message, 'err')
      } finally {
        this.submitting = false
      }
    },

    // ===== 打印 =====
    doPrint() { window.print() },
    closePrint() {
      this.printDoc = null
    },
    printOrderDetail() {
      const d = this.orderDetail
      if (!d) return
      const isPur = this.orderDetailType === 'purchase'
      const sign = d.kind === 'return' ? -1 : 1
      const rows = d.items.map(it => [
        it.product_name + (it.sku ? '（' + it.sku + '）' : ''),
        this.qfmt(it.qty) + (it.unit ? ' ' + it.unit : ''),
        this.money(isPur ? it.unit_cost : it.unit_price),
        this.money(sign * (isPur ? it.qty * it.unit_cost : it.qty * it.unit_price)),
      ])
      const totals = [['合计', this.money(d.total)]]
      if (Number(d.discount)) totals.push(['整单优惠', '-' + this.money(d.discount)])
      totals.push(['净额', this.money(d.total - d.discount)])
      if (d.kind !== 'return') {
        totals.push(['已' + (isPur ? '付' : '收'), this.money(d.paid)])
        totals.push(['欠款', this.money(d.total - d.discount - d.paid)])
      }
      this.orderDetail = null

      const partyLabel = isPur ? '供应商' : '客户'
      const partyName = isPur ? (d.supplier_name || '—') : (d.customer_name || '散客')
      const partyPhone = isPur ? d.supplier_phone : d.customer_phone
      const partyAddr = isPur ? d.supplier_address : d.customer_address
      const partyContact = isPur ? d.supplier_contact_man : d.customer_contact_man

      const meta = [
        ['单据编号', 'No.' + d.id],
        ['单据日期', this.dt(d.created_at)],
        [partyLabel + '名称', partyName],
      ]
      if (partyContact) meta.push([partyLabel + '联系人', partyContact])
      if (partyPhone) meta.push([partyLabel + '电话', partyPhone])
      if (partyAddr) meta.push([partyLabel + '地址', partyAddr])
      if (d.note) meta.push(['备注信息', d.note])

      this.printDoc = {
        title: (isPur ? '购货入库单' : '销货出库单') + (d.kind === 'return' ? '（退货）' : ''),
        no: 'No.' + d.id,
        meta,
        table: { head: ['商品名称', '数量', '单价', '小计金额'], rows },
        totals,
        sign: isPur ? '供应商签字' : '客户签收',
      }
    },
    printStock() {
      const rows = this.products.filter(p => !p.archived).map(p => [
        p.name, p.sku || '—', p.category || '—', p.unit,
        p.no_stock ? '服务' : this.qfmt(p.stock),
        this.money(p.avg_cost),
        this.money(p.no_stock ? 0 : p.stock * p.avg_cost),
      ])
      this.printDoc = {
        title: '库存清单',
        no: '',
        meta: [['打印时间', this.dt(new Date().toISOString())], ['商品数', String(this.products.filter(p => !p.archived).length)]],
        table: { head: ['商品', '编号', '类别', '单位', '库存', '成本均价', '库存价值'], rows },
        totals: [
          ['库存总量', this.qfmt(this.products.filter(p => !p.archived && !p.no_stock).reduce((s, p) => s + Number(p.stock || 0), 0))],
          ['库存总成本', this.money(this.stockValue)],
        ],
        sign: '盘点人签字',
      }
    },
    printFundsRow() {
      const x = this.fundsDetail
      if (!x) return
      this.fundsDetail = null
      this.printDoc = {
        title: x.type === 'income' ? '收款收据' : '付款凭据',
        no: '',
        meta: [
          ['日期', this.dt(x.created_at)],
          ['类型', x.type === 'income' ? '其他收入' : '其他支出'],
          ['往来单位', x.party_name || '—'],
          ['结算账户', x.account_name || '—'],
          ['备注', x.note || '—'],
        ],
        table: null,
        totals: [['金额', this.money(x.amount)]],
        sign: x.type === 'income' ? '收款人签字' : '经手人签字',
      }
    },
    printFundsList() {
      if (!this.fundsRep) return
      const rows = this.fundsListFiltered.map(x => [
        this.dt(x.created_at), x.type === 'income' ? '收入' : '支出', x.party_name || '—', x.account_name || '—', this.money(x.amount), x.note || '—',
      ])
      this.printDoc = {
        title: '其他收支明细表',
        no: '',
        meta: [['打印时间', this.dt(new Date().toISOString())], ['区间', this.repFrom + ' 至 ' + this.repTo]],
        table: { head: ['时间', '类型', '往来单位', '账户', '金额', '备注'], rows },
        totals: [
          ['收入合计', this.money(this.fundsRep.income)],
          ['支出合计', this.money(this.fundsRep.expense)],
          ['净额', this.money(this.fundsRep.income - this.fundsRep.expense)],
        ],
        sign: '经手人签字',
      }
    },

    // ===== 资金 =====
    openFundModal(type) {
      this.fundModal = { type, party_id: '', account_id: '', amount: '', note: '', date: '' }
    },
    fundPartyLabel(type) {
      if (type === 'receipt') return '客户 *'
      if (type === 'payment') return '供应商 *'
      if (type === 'income') return '客户（可选）'
      return '供应商（可选）'
    },
    fundPartyList(type) {
      if (type === 'receipt' || type === 'income') return this.customers
      return this.suppliers
    },
    async saveFund() {
      const m = this.fundModal
      if (!Number(m.amount) || Number(m.amount) <= 0) return this.toast('请填写大于 0 的金额', 'err')
      if (!m.account_id) return this.toast('请选择结算账户', 'err')
      if ((m.type === 'receipt' || m.type === 'payment') && !m.party_id) return this.toast('请选择往来单位', 'err')
      try {
        const body = { ...m, amount: Number(m.amount) }
        if (!m.date) delete body.date
        await api('/funds', { method: 'POST', body })
        this.fundModal = null
        await this.loadFunds()
        this.toast('已入账')
      } catch (e) { this.toast(e.message, 'err') }
    },
    async delFund(f) {
      if (!confirm('确定删除该笔流水？余额与欠款将自动重算。')) return
      try {
        await api('/funds/' + f.id, { method: 'DELETE' })
        await this.loadFunds()
        this.toast('已删除')
      } catch (e) { this.toast(e.message, 'err') }
    },
    openAccountModal(a) {
      this.accountModal = a
        ? { id: a.id, name: a.name, opening_balance: a.opening_balance, note: a.note }
        : { id: null, name: '', opening_balance: '', note: '' }
    },
    async saveAccount() {
      const m = this.accountModal
      if (!m.name.trim()) return this.toast('请填写账户名称', 'err')
      try {
        if (m.id) await api('/accounts/' + m.id, { method: 'PUT', body: m })
        else await api('/accounts', { method: 'POST', body: m })
        this.accountModal = null
        await this.loadFunds()
        this.toast('已保存')
      } catch (e) { this.toast(e.message, 'err') }
    },
    async delAccount(a) {
      if (!confirm(`确定删除账户「${a.name}」？`)) return
      try {
        await api('/accounts/' + a.id, { method: 'DELETE' })
        await this.loadFunds()
        this.toast('已删除')
      } catch (e) { this.toast(e.message, 'err') }
    },

    // ===== 往来单位 =====
    openPartyModal(p) {
      this.partyModal = p
        ? { ...p }
        : { id: null, type: this.partyTab, name: '', phone: '', note: '', opening_debt: '' }
    },
    async saveParty() {
      const m = this.partyModal
      if (!m.name.trim()) return this.toast('请填写名称', 'err')
      try {
        if (m.id) await api('/parties/' + m.id, { method: 'PUT', body: m })
        else await api('/parties', { method: 'POST', body: m })
        this.partyModal = null
        this.parties = await api('/parties')
        this.toast('已保存')
      } catch (e) { this.toast(e.message, 'err') }
    },
    async delParty(p) {
      if (!confirm(`确定删除「${p.name}」？`)) return
      await api('/parties/' + p.id, { method: 'DELETE' })
      this.parties = await api('/parties')
      this.toast('已删除')
    },

    // ===== 报表 =====
    setRepRange(kind) {
      if (kind === 'today') { this.repFrom = todayStr(); this.repTo = todayStr() }
      else if (kind === 'month') { this.repFrom = monthStartStr(); this.repTo = todayStr() }
      else if (kind === 'prev') {
        const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1)
        this.repFrom = dstr(d)
        const e = new Date(d.getFullYear(), d.getMonth() + 1, 0)
        this.repTo = dstr(e)
      }
      this.loadReports()
    },
    csvProfit() {
      const p = this.profit
      exportCSV(`毛利报表_${this.repFrom}_${this.repTo}.csv`, ['商品', '销量', '销售额', '成本', '毛利'],
        [...p.rows.map((r) => [r.name, r.qty, r.revenue, r.cost, r.profit]), ['合计（毛利）', '', p.total.revenue, p.total.cost, p.total.profit], ['整单优惠', '', '', '', p.discount]])
    },
    csvSummary() {
      exportCSV(`进销存汇总_${this.repFrom}_${this.repTo}.csv`,
        ['商品', '期初', '采购入库', '采购退货', '销售出库', '销售退货', '盘盈', '盘亏', '期末'],
        this.summary.rows.map((r) => [r.name || this.productMap[r.product_id]?.name || r.product_id, r.opening, r.purchase_in, r.purchase_return, r.sale_out, r.sale_return, r.adjust_in, r.adjust_out, r.closing]))
    },
    csvDebt() {
      exportCSV('往来欠款.csv', ['类型', '名称', '电话', '当前欠款'],
        [...this.customers.map((p) => ['客户', p.name, p.phone, p.debt || 0]), ...this.suppliers.map((p) => ['供应商', p.name, p.phone, p.debt || 0])])
    },
  },
  mounted() {
    window.addEventListener('hashchange', this.onHash)
    this.onHash()
    // 应用启动时先加载公司配置（公开接口，无需登录），避免刷新后回退到默认值
    api('/settings/company')
      .then((res) => {
        this.company = { ...this.company, ...res }
        document.title = this.company.app_title || 'Cloud ERP 进销存'
      })
      .catch(() => {})
    // 先显示加载页，再异步检查登录状态，避免已登录用户刷新时闪登录框
    this.booted = true
    const check = api('/me')
    const guard = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
    Promise.race([check, guard])
      .then((res) => {
        this.loggedIn = true
        this.currentUser = res.user || { id: 1, username: 'admin', name: '管理员', role: 'admin', permissions: [] }
        this.authReady = true
        this.loadView()
      })
      .catch(() => {
        this.loggedIn = false
        this.authReady = true
      })
  },
  template: '#app-template',
})

/* 商品搜索选择器：输入名称/编号/条码/类别过滤，支持键盘回车选中
   下拉用 fixed 定位（随输入框实时定位），避免被表格的 overflow 裁剪 */
app.component('product-picker', {
  props: {
    products: { type: Array, default: () => [] },
    modelValue: { type: [Number, String], default: '' },
    mode: { type: String, default: 'sale' }, // purchase | sale
    placeholder: { type: String, default: '搜索商品（名称/编号/条码）' },
  },
  emits: ['update:modelValue'],
  data() {
    return { query: '', open: false, dropStyle: {} }
  },
  computed: {
    selected() {
      return this.products.find((p) => p.id === Number(this.modelValue)) || null
    },
    inputText() {
      return this.open ? this.query : (this.selected ? this.selected.name : '')
    },
    matches() {
      const kw = this.query.trim().toLowerCase()
      if (!kw) return this.products.slice(0, 30)
      return this.products
        .filter((p) =>
          p.name.toLowerCase().includes(kw) ||
          (p.sku || '').toLowerCase().includes(kw) ||
          (p.barcode || '').toLowerCase().includes(kw) ||
          (p.category || '').toLowerCase().includes(kw)
        )
        .slice(0, 30)
    },
  },
  methods: {
    qfmt(n) {
      const x = Number(n) || 0
      return Number.isInteger(x) ? String(x) : String(+x.toFixed(3))
    },
    suffix(p) {
      if (p.no_stock) return '服务'
      return '库存 ' + this.qfmt(p.stock)
    },
    pick(p) {
      this.$emit('update:modelValue', p.id)
      this.query = ''
      this.setOpen(false)
    },
    onInput(e) {
      this.query = e.target.value
      this.setOpen(true)
    },
    onEnter() {
      if (this.matches.length) this.pick(this.matches[0])
    },
    setOpen(v) {
      this.open = v
      if (v) this.$nextTick(() => this.updatePos())
    },
    updatePos() {
      const el = this.$refs.input
      if (!el || !this.open) return
      const r = el.getBoundingClientRect()
      const below = window.innerHeight - r.bottom
      const dropUp = below < 200 && r.top > 260
      const maxH = Math.max(140, Math.min(280, (dropUp ? r.top : below) - 12))
      this.dropStyle = {
        position: 'fixed',
        left: r.left + 'px',
        width: Math.max(r.width, 240) + 'px',
        zIndex: 100,
        ...(dropUp
          ? { bottom: window.innerHeight - r.top + 2 + 'px' }
          : { top: r.bottom + 2 + 'px' }),
        maxHeight: maxH + 'px',
      }
    },
  },
  mounted() {
    this._onScroll = () => { if (this.open) this.updatePos() }
    window.addEventListener('scroll', this._onScroll, true)
    window.addEventListener('resize', this._onScroll)
  },
  unmounted() {
    window.removeEventListener('scroll', this._onScroll, true)
    window.removeEventListener('resize', this._onScroll)
  },
  template: `
    <div style="position:relative">
      <input ref="input" :value="inputText" :placeholder="placeholder"
             @input="onInput" @focus="setOpen(true)"
             @keydown.enter.prevent="onEnter"
             @keydown.esc="setOpen(false)"
             @blur="setOpen(false)" style="width:100%" />
      <div class="picker-list" :style="dropStyle" v-if="open && matches.length">
        <div v-for="p in matches" :key="p.id" class="picker-item" @mousedown.prevent="pick(p)" @click="pick(p)">
          {{ p.name }}<span class="text-muted" style="margin-left:6px;font-size:12px">{{ p.sku ? ' ' + p.sku : '' }} · {{ suffix(p) }}</span>
        </div>
      </div>
      <div class="picker-list" :style="dropStyle" v-else-if="open">
        <div class="picker-item text-muted">没有匹配的商品，可用下方「＋ 新商品」添加</div>
      </div>
    </div>
  `,
})

app.mount('#app')
