export type AdminSessionPrincipal = {
  id: number;
  username: string;
};

export type AuthSource = "session-cookie" | "session-bearer";

export type AuthVariables = {
  admin: AdminSessionPrincipal;
  authSource: AuthSource;
  authSessionToken?: string;
};
