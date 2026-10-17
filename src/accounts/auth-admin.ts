import { Inject, Injectable } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { AppError } from '../common/errors.js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';

export interface NewAuthUser {
  email: string;
  password: string;
  displayName: string;
}

/** Creates and deletes sign-in accounts in the auth provider. */
export abstract class AuthAdmin {
  abstract readonly configured: boolean;
  /** Creates a confirmed account and returns its id. */
  abstract createUser(user: NewAuthUser): Promise<string>;
  abstract deleteUser(id: string): Promise<void>;
}

export const notConfigured = () =>
  new AppError(
    'ACCOUNTS_NOT_CONFIGURED',
    503,
    'Creating accounts is not set up on the server. Add SUPABASE_SECRET_KEY to the backend environment.',
  );

/** Uses the Supabase Auth admin API with the secret key (server-side only). */
@Injectable()
export class SupabaseAuthAdmin extends AuthAdmin {
  private readonly client: SupabaseClient | null;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.client = config.supabaseSecretKey
      ? createClient(config.supabaseUrl, config.supabaseSecretKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        })
      : null;
  }

  get configured(): boolean {
    return this.client !== null;
  }

  async createUser({ email, password, displayName }: NewAuthUser): Promise<string> {
    if (!this.client) throw notConfigured();
    const { data, error } = await this.client.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });
    if (error || !data.user) throw toAuthError(error);
    return data.user.id;
  }

  async deleteUser(id: string): Promise<void> {
    if (!this.client) throw notConfigured();
    const { error } = await this.client.auth.admin.deleteUser(id);
    if (error) throw toAuthError(error);
  }
}

function toAuthError(error: { code?: string; status?: number; message?: string } | null): AppError {
  switch (error?.code) {
    case 'email_exists':
    case 'user_already_exists':
      return new AppError('EMAIL_TAKEN', 409, 'An account with this email already exists.');
    case 'weak_password':
      return new AppError('WEAK_PASSWORD', 422, 'This password is too weak. Use a longer, less common password.');
    case 'email_address_invalid':
      return new AppError('VALIDATION_FAILED', 400, 'Enter a valid email address.');
  }
  if (error?.status === 401 || error?.status === 403) {
    return new AppError('ACCOUNTS_NOT_CONFIGURED', 503, 'The server’s SUPABASE_SECRET_KEY is not valid.');
  }
  return new AppError('AUTH_PROVIDER_ERROR', 502, 'The sign-in service could not complete the request. Please try again.');
}
