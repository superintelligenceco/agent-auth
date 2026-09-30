import {
  type CryptoKey,
  decodeJwt,
  type JWTPayload,
  type JWTVerifyGetKey,
  jwtVerify,
  SignJWT,
} from "jose";
import { ALG, type SigningKey } from "./keys.js";

export const TOKEN_TYPE = "agent-auth+jwt";

/** Claims carried by every agent token. */
export interface AgentTokenClaims {
  /** Issuer URL of the agent-auth service. */
  iss: string;
  /** Agent the token was issued to. */
  sub: string;
  /** Unique token id. */
  jti: string;
  iat: number;
  exp: number;
  /** Principal (the human or account) that delegated authority. */
  prn: string;
  /** Grant id the token descends from. */
  gnt: string;
  /** Scopes in canonical text form. */
  scp: string[];
  /** Parent token id for attenuated tokens. */
  par?: string;
  /** Delegation depth. The root token of a grant has depth 0. */
  dep: number;
  /** Maximum number of allowed uses for this token, if limited. */
  mxu?: number;
}

export async function signToken(claims: AgentTokenClaims, key: SigningKey): Promise<string> {
  const { iss, sub, jti, iat, exp, ...rest } = claims;
  return new SignJWT({ ...rest })
    .setProtectedHeader({ alg: ALG, typ: TOKEN_TYPE, kid: key.kid })
    .setIssuer(iss)
    .setSubject(sub)
    .setJti(jti)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(key.privateKey);
}

export class TokenError extends Error {
  constructor(
    readonly code: "invalid_token" | "expired",
    message: string,
  ) {
    super(message);
    this.name = "TokenError";
  }
}

function assertClaims(p: JWTPayload): AgentTokenClaims {
  const ok =
    typeof p.iss === "string" &&
    typeof p.sub === "string" &&
    typeof p.jti === "string" &&
    typeof p.iat === "number" &&
    typeof p.exp === "number" &&
    typeof p.prn === "string" &&
    typeof p.gnt === "string" &&
    typeof p.dep === "number" &&
    Array.isArray(p.scp) &&
    p.scp.every((s) => typeof s === "string");
  if (!ok) throw new TokenError("invalid_token", "token is missing required claims");
  return p as unknown as AgentTokenClaims;
}

/**
 * Verifies signature, type, issuer and expiry. Does not check revocation or
 * use counts; only the service can do that.
 */
export async function verifyToken(
  token: string,
  key: CryptoKey | JWTVerifyGetKey,
  opts: { issuer: string; now?: Date },
): Promise<AgentTokenClaims> {
  try {
    const options = {
      issuer: opts.issuer,
      algorithms: [ALG],
      typ: TOKEN_TYPE,
      ...(opts.now ? { currentDate: opts.now } : {}),
    };
    const { payload } =
      typeof key === "function"
        ? await jwtVerify(token, key, options)
        : await jwtVerify(token, key, options);
    return assertClaims(payload);
  } catch (err) {
    if (err instanceof TokenError) throw err;
    const code = (err as { code?: string }).code;
    if (code === "ERR_JWT_EXPIRED") throw new TokenError("expired", "token has expired");
    throw new TokenError("invalid_token", (err as Error).message || "invalid token");
  }
}

/** Decodes claims without verifying anything. Use only for display. */
export function decodeToken(token: string): AgentTokenClaims {
  return decodeJwt(token) as unknown as AgentTokenClaims;
}
