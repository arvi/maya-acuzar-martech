/** Attached to the request by JwtAuthGuard once a bearer token checks out. */
export interface AuthenticatedIdentity {
  authIdentityId: number;
  accountHolderId: number;
  subject: string;
  username: string;
  displayName: string;
  holderStatus: string;
}

/** Claims of a mimicked Keycloak access token. */
export interface AccessTokenClaims {
  iss: string;
  sub: string;
  preferred_username: string;
  email: string;
  realm_access: { roles: string[] };
}
