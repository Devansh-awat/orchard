interface AdoptionClient {
  session: { updateMany(args: any): Promise<unknown> };
  passkey: { deleteMany(args: any): Promise<unknown> };
  apiToken: { deleteMany(args: any): Promise<unknown> };
  gitConnection: { deleteMany(args: any): Promise<unknown> };
  gitHubAppInstallation: { deleteMany(args: any): Promise<unknown> };
  federatedIdentity: { deleteMany(args: any): Promise<unknown> };
  user: { update(args: any): Promise<unknown> };
}

export async function discardUnverifiedCredentials(db: AdoptionClient, userId: string) {
  await db.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
  await db.passkey.deleteMany({ where: { userId } });
  await db.apiToken.deleteMany({ where: { userId } });
  await db.gitConnection.deleteMany({ where: { userId } });
  await db.gitHubAppInstallation.deleteMany({ where: { userId } });
  await db.federatedIdentity.deleteMany({ where: { userId } });
  await db.user.update({
    where: { id: userId },
    data: {
      passwordHash: null,
      githubId: null,
      githubUsername: null,
      githubAccessToken: null,
      githubTokenExpiresAt: null,
      githubRefreshToken: null,
      githubRefreshTokenExpiresAt: null
    }
  });
}
