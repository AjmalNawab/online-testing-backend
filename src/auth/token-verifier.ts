import { Inject, Injectable } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { APP_CONFIG, type AppConfig } from '../config/env.js';

export interface VerifiedToken {
  userId: string;
  email: string | null;
}

/** Verifies an access token and returns its user, or null if invalid/expired. */
export abstract class TokenVerifier {
  abstract verify(token: string): Promise<VerifiedToken | null>;
}

/** Asks Supabase Auth to validate the token (handles revocation and sign-out). */
@Injectable()
export class SupabaseTokenVerifier extends TokenVerifier {
  private readonly client: SupabaseClient;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.client = createClient(config.supabaseUrl, config.supabasePublishableKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  async verify(token: string): Promise<VerifiedToken | null> {
    const { data, error } = await this.client.auth.getUser(token);
    if (error || !data.user) return null;
    return { userId: data.user.id, email: data.user.email ?? null };
  }
}
