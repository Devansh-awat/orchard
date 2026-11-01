import assert from 'node:assert/strict';
import test from 'node:test';

process.env.CLUSTER_SNAPSHOT_TTL_MS = '40';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeCluster() {
  let lists = 0;
  let generation = 0;
  const kc = {
    makeApiClient: () => ({
      listPodForAllNamespaces: async () => {
        lists += 1;
        generation += 1;
        await sleep(20);
        return {
          body: {
            items: [
              {
                metadata: { namespace: `ns-${generation}`, name: 'p' },
                spec: { containers: [] },
                status: { phase: 'Running' }
              }
            ]
          }
        };
      }
    })
  };
  return { kc: kc as any, lists: () => lists };
}

test('a view read serves the last snapshot and refreshes behind it, a strict read waits', async () => {
  const { clusterPods, invalidateClusterSnapshot } =
    await import('../src/kubernetes/cluster-snapshot');
  invalidateClusterSnapshot();
  const cluster = fakeCluster();

  const first = await clusterPods(cluster.kc);
  assert.equal(first[0].namespace, 'ns-1');
  assert.equal(cluster.lists(), 1);

  await sleep(60);
  const view = await clusterPods(cluster.kc, { staleMs: 10_000 });
  assert.equal(view[0].namespace, 'ns-1');
  assert.equal(cluster.lists(), 2);

  await sleep(30);
  const refreshed = await clusterPods(cluster.kc, { staleMs: 10_000 });
  assert.equal(refreshed[0].namespace, 'ns-2');

  await sleep(60);
  const strict = await clusterPods(cluster.kc);
  assert.equal(strict[0].namespace, 'ns-3');
  assert.equal(cluster.lists(), 3);

  await sleep(60);
  const tooOld = await clusterPods(cluster.kc, { staleMs: 10 });
  assert.equal(tooOld[0].namespace, 'ns-4');
  invalidateClusterSnapshot();
});
