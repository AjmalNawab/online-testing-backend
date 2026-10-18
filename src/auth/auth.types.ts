export type Role = 'admin' | 'teacher' | 'student';

export interface AuthUser {
  id: string;
  email: string | null;
  displayName: string;
  role: Role;
  /** A teacher's request for administrator access, if any. */
  accessRequest: 'pending' | 'rejected' | null;
}

export interface AuthenticatedRequest {
  user?: AuthUser;
}
