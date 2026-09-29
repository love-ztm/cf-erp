declare module '*.sql' {
  const content: string
  export default content
}

type UserRole = 'admin' | 'staff' | 'sales'

type AuthUser = {
  id: number
  username: string
  name: string
  role: UserRole
  status: number
  permissions: string[]
}

type Env = {
  DB: D1Database
  ASSETS: Fetcher
  ADMIN_PASSWORD?: string
}

