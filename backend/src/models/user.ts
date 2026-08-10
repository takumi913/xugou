// 用户类型定义
export interface User {
  id: number;
  username: string;
  password: string;
  email: string | null;
  created_at: string;
  updated_at: string;
}
