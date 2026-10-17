/** Calls a Postgres function by name with named arguments and returns its JSON result. */
export type RpcCaller = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

const FUNCTION_NAME = /^[a-z_][a-z0-9_]*$/;

/** Builds `select public.fn(p_a => $1, p_b => $2::jsonb) as r` with JSON-encoded object arguments. */
export function buildRpcQuery(fn: string, args: Record<string, unknown>): { text: string; values: unknown[] } {
  if (!FUNCTION_NAME.test(fn)) throw new Error(`Invalid function name: ${fn}`);
  const keys = Object.keys(args);
  const isJson = (v: unknown) => v !== null && typeof v === 'object';
  const named = keys
    .map((k, i) => {
      if (!FUNCTION_NAME.test(k)) throw new Error(`Invalid argument name: ${k}`);
      return `${k} => $${i + 1}${isJson(args[k]) ? '::jsonb' : ''}`;
    })
    .join(', ');
  return {
    text: `select public.${fn}(${named}) as r`,
    values: keys.map((k) => (isJson(args[k]) ? JSON.stringify(args[k]) : args[k])),
  };
}
