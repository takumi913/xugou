export interface AdminCredentialRecord {
  id: number;
  username: string;
  password: string;
}

export interface PublicAdminProfile {
  id: number;
  username: string;
  email: string | null;
  created_at: string;
  updated_at: string;
}
