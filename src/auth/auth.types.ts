export type Role = 'admin' | 'student';

export interface AuthUser {
  id: string;
  email: string | null;
  displayName: string;
  role: Role;
}

export interface AuthenticatedRequest {
  user?: AuthUser;
}
