import { execSync } from 'node:child_process';

const needsEnv =
  !process.env.SUPABASE_SERVICE_ROLE_KEY ||
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_DB_URL ||
  !process.env.SUPABASE_ANON_KEY;

if (needsEnv) {
  try {
    const out = execSync('supabase status -o env', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const env: Record<string, string> = {};
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)="(.*)"$/);
      if (m) env[m[1]!] = m[2]!;
    }
    if (env.API_URL) process.env.SUPABASE_URL ??= env.API_URL;
    if (env.DB_URL) process.env.SUPABASE_DB_URL ??= env.DB_URL;
    if (env.ANON_KEY) process.env.SUPABASE_ANON_KEY ??= env.ANON_KEY;
    if (env.SECRET_KEY) process.env.SUPABASE_SERVICE_ROLE_KEY ??= env.SECRET_KEY;
  } catch {
    // Local Supabase isn't running. Tests that need it will fail with clear errors.
  }
}
