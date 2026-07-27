export function loadUser(id: string): string {
  return formatUser(fetchUser(id));
}

function fetchUser(id: string): { id: string; name: string } {
  return { id, name: 'Ada' };
}

function formatUser(user: { id: string; name: string }): string {
  return `${user.name} (${user.id})`;
}
