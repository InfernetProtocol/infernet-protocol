export const revalidate = 60;

const GITHUB_LATEST_RELEASE = 'https://github.com/InfernetProtocol/infernet-protocol/releases/latest';

export async function GET() {
    try {
        const releaseResponse = await fetch(GITHUB_LATEST_RELEASE, {
            method: 'HEAD',
            redirect: 'manual',
            headers: {
                'user-agent': 'infernet-release-feed'
            },
            next: { revalidate: 60 },
            signal: AbortSignal.timeout(10_000)
        });
        const location = releaseResponse.headers.get('location');
        if (!location) {
            return Response.json({ error: 'Release version is temporarily unavailable' }, {
                status: 502,
                headers: { 'cache-control': 'no-store' }
            });
        }

        const releasePath = new URL(location).pathname;
        const tag = releasePath.match(/\/releases\/tag\/v?(\d+\.\d+\.\d+)$/i)?.[1];
        const version = tag ?? null;
        if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
            return Response.json({ error: 'Release version is invalid' }, {
                status: 502,
                headers: { 'cache-control': 'no-store' }
            });
        }

        return Response.json({ version }, {
            headers: {
                'cache-control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=300'
            }
        });
    } catch {
        return Response.json({ error: 'Release version is temporarily unavailable' }, {
            status: 502,
            headers: { 'cache-control': 'no-store' }
        });
    }
}
