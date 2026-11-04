export function signedInUser(user: {
  id: string;
  email: string;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string | null;
  setupCompleted: boolean;
  isSuperAdmin: boolean;
}) {
  const base = {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    imageUrl: user.imageUrl,
    setupCompleted: user.setupCompleted
  };
  return user.isSuperAdmin ? { ...base, isSuperAdmin: true as const } : base;
}
