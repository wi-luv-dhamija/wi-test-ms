// Minimal GitHub REST client for the queue manager (built-in GITHUB_TOKEN, no dependencies).
const API = process.env.GITHUB_API_URL ?? 'https://api.github.com';
export const REPO = `/repos/${process.env.GITHUB_REPOSITORY}`;

export async function api(method, path, body, { allow404 = false, raw = false } = {}) {
  const res = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404 && allow404) return null;
  if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status} ${await res.text()}`);
  if (raw) return res.text();
  return res.status === 204 ? null : res.json();
}

/** GETs every page of a list endpoint. */
export async function paginate(path) {
  const items = [];
  for (let page = 1; ; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = await api('GET', `${path}${sep}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

export const getPr = (number) => api('GET', `${REPO}/pulls/${number}`, null, { allow404: true });

/** write/maintain/admin may change the queue. */
export async function canWrite(login) {
  const res = await api(
    'GET',
    `${REPO}/collaborators/${encodeURIComponent(login)}/permission`,
    null,
    { allow404: true },
  );
  return ['admin', 'write'].includes(res?.permission);
}

export const comment = (issue, body) => api('POST', `${REPO}/issues/${issue}/comments`, { body });
export const react = (commentId, content) =>
  api('POST', `${REPO}/issues/comments/${commentId}/reactions`, { content }).catch((e) =>
    console.log(`::warning::Could not add reaction: ${e.message}`),
  );

export async function ensureLabels(colors) {
  const existing = new Set((await paginate(`${REPO}/labels`)).map((l) => l.name));
  for (const [name, [color, description]] of Object.entries(colors)) {
    if (!existing.has(name)) await api('POST', `${REPO}/labels`, { name, color, description });
  }
}

/** Replaces any queue:* label on an issue/PR with `target` (or none); other labels are untouched. */
export async function setQueueLabel(number, target) {
  const current = (await api('GET', `${REPO}/issues/${number}/labels`)).map((l) => l.name);
  for (const name of current) {
    if (name.startsWith('queue:') && name !== target) {
      await api('DELETE', `${REPO}/issues/${number}/labels/${encodeURIComponent(name)}`, null, {
        allow404: true,
      });
    }
  }
  if (target && !current.includes(target))
    await api('POST', `${REPO}/issues/${number}/labels`, { labels: [target] });
}

/** Creates or updates the single bot comment carrying `marker`. Returns its id. */
export async function upsertSticky(number, marker, body, knownId) {
  if (
    knownId &&
    (await api('PATCH', `${REPO}/issues/comments/${knownId}`, { body }, { allow404: true }))
  ) {
    return knownId;
  }
  const comments = await paginate(`${REPO}/issues/${number}/comments`);
  const mine = comments.find((c) => c.user?.type === 'Bot' && c.body?.includes(marker));
  if (mine) {
    await api('PATCH', `${REPO}/issues/comments/${mine.id}`, { body });
    return mine.id;
  }
  return (await comment(number, body)).id;
}
