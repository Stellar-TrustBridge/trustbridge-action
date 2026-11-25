
# Typescript snippets

- `np` - nextPage
- `npssp` - nextPageServerSideProps
- `npsp` - nextPageStaticProps
- `npspth` - nextPageStaticPaths
- `nssp` - nextServerSideProps
- `nsp` - nextStaticProps
- `nspth` - nextStaticPaths
- `nip` - nextInitialProps
- `nimg` - nextImage
- `napp` - nextApp
- `ndoc` - nextDocument
- `napi` - nextApi
- `nmid` - nextMiddleware

## `np` - nextPage

```typescript
import { NextPage } from 'next'

interface Props {}

const FileName: NextPage<Props> = ({}) => {
  return <div></div>
}

export default FileName
```

## `npssp` - nextPageServerSideProps

```typescript
import { NextPage, GetServerSideProps } from 'next'

interface Props {}

const FileName: NextPage<Props> = ({}) => {
  return <div></div>
}

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return {
    props: {}
  }
}

export default FileName
```

## `npsp` - nextPageStaticProps

```typescript
import { NextPage, GetStaticProps } from 'next'

interface Props {}

const FileName: NextPage<Props> = ({}) => {
  return <div></div>
}

export const getStaticProps: GetStaticProps = async (ctx) => {
  return {
    props: {},
  }
}

export default FileName
```

## `npspth` - nextPageStaticPaths

```typescript
import { NextPage, GetStaticPaths } from 'next'

interface Props {}

const FileName: NextPage<Props> = ({}) => {
  return <div></div>
}

export const getStaticPaths: GetStaticPaths = async () => {
  return {
    paths: [],
    fallback: false,
  }
}

export default FileName
```

## `nssp` - nextServerSideProps

```typescript
export const getServerSideProps: GetServerSideProps = async (ctx) => {
  return {
    props: {}
  }
}
```

## `nsp` - nextStaticProps

```typescript
export const getStaticProps: GetStaticProps = async (ctx) => {
  return {
    props: {},
  }
}
```

## `nspth` - nextStaticPaths

```typescript
export const getStaticPaths: GetStaticPaths = async () => {
  return {
    paths: [],
    fallback: false,
  }
}
```

## `nip` - nextInitialProps

```typescript
FileName.getInitialProps = async (ctx) => {
  return {
    
  }
}
```

## `nimg` - nextImage

```typescript
<Image src="" alt="" />
```

## `napp` - nextApp

```typescript
import type { AppProps } from 'next/app'

export default function MyApp({ Component, pageProps }: AppProps) {
  return <Component {...pageProps} />
}
```

## `ndoc` - nextDocument

```typescript
import Document, { Html, Head, Main, NextScript, DocumentContext } from 'next/document'

class MyDocument extends Document {
  static async getInitialProps(ctx: DocumentContext) {
    const initialProps = await Document.getInitialProps(ctx)
    return { ...initialProps }
  }

  render() {
    return (
      <Html>
        <Head />
        <body>
          <Main />
          <NextScript />
        </body>
      </Html>
    );
  }
}

export default MyDocument
```

## `napi` - nextApi

```typescript
import type { NextApiRequest, NextApiResponse } from 'next'

interface Data {}

export default async function handler(req: NextApiRequest, res: NextApiResponse<Data>) {
  
}
```

## `nmid` - nextMiddleware

```typescript
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export async function middleware(request: NextRequest) {
  
}

export const config = {
  matcher: '/about/:path*',
}
```

## Local mocked Horizon runs

Unit-test Horizon clients against recorded, production-shaped account JSON instead of a live Horizon — no network, no Docker. The helpers live in [`docs/examples/mocked-horizon.ts`](examples/mocked-horizon.ts) and are exercised by `__tests__/typescript-snippets-mocked-horizon.test.ts` (Issue #789).

### `mhz` - mockedHorizonTest

```ts
import { createMockHorizon, fetchMockedAccount, loadAccountFixture } from '../docs/examples/mocked-horizon';

jest.mock('@actions/core');

it('reads a funded account with a USDC trustline', async () => {
  const funded = loadAccountFixture('account-funded'); // fixtures/account-funded.json
  const horizon = createMockHorizon({ [funded.account_id]: funded });

  const account = await fetchMockedAccount(horizon.fetchFn, funded.account_id);

  expect(account.balances.some((b) => 'asset_code' in b && b.asset_code === 'USDC')).toBe(true);
  expect(horizon.calls).toHaveLength(1);
});
```

### `mhz404` - mockedHorizonUnfunded

Accounts missing from the route map get Horizon's real `404` problem JSON, so the unfunded path behaves like production:

```ts
it('treats a missing account as unfunded', async () => {
  const horizon = createMockHorizon({});
  await expect(fetchMockedAccount(horizon.fetchFn, 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'))
    .rejects.toMatchObject({ statusCode: 404 });
});
```

### `mhzerr` - mockedHorizonOutage

```ts
it('surfaces a Horizon outage', async () => {
  const horizon = createMockHorizon({ [id]: { status: 503, body: { title: 'Service Unavailable' } } });
  await expect(fetchMockedAccount(horizon.fetchFn, id)).rejects.toBeInstanceOf(HorizonError);
});
```

Notes:

- `fetchMockedAccount` disables the cache and retries so each test is deterministic and fast.
- Build variations with `makeHorizonAccount()` from `__tests__/helpers/horizon-account.ts` (balances, trustlines, flags) and pass them as routes.
- `loadAccountFixture` rejects path-like names and non-account JSON with clear errors. Fixtures contain only public test addresses — never commit real user accounts.
