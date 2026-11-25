
# Javascript snippets

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

```javascript
const FileName = ({}) => {
  return <div></div>
}

export default FileName
```

## `npssp` - nextPageServerSideProps

```javascript
const FileName = ({}) => {
  return <div></div>
}

export const getServerSideProps = async (ctx) => {
  return {
    props: {}
  }
}

export default FileName
```

## `npsp` - nextPageStaticProps

```javascript
const FileName = ({}) => {
  return <div></div>
}

export const getStaticProps = async (ctx) => {
  return {
    props: {},
  }
}

export default FileName
```

## `npspth` - nextPageStaticPaths

```javascript
const FileName = ({}) => {
  return <div></div>
}

export const getStaticPaths = async () => {
  return {
    paths: [],
    fallback: false,
  }
}

export default FileName
```

## `nssp` - nextServerSideProps

```javascript
export const getServerSideProps = async (ctx) => {
  return {
    props: {}
  }
}
```

## `nsp` - nextStaticProps

```javascript
export const getStaticProps = async (ctx) => {
  return {
    props: {},
  }
}
```

## `nspth` - nextStaticPaths

```javascript
export const getStaticPaths = async () => {
  return {
    paths: [],
    fallback: false,
  }
}
```

## `nip` - nextInitialProps

```javascript
FileName.getInitialProps = async (ctx) => {
  return {
    
  }
}
```

## `nimg` - nextImage

```javascript
<Image src="" alt="" />
```

## `napp` - nextApp

```javascript
export default function MyApp({ Component, pageProps }) {
  return <Component {...pageProps} />
}
```

## `ndoc` - nextDocument

```javascript
import Document, { Html, Head, Main, NextScript } from 'next/document'

class MyDocument extends Document {
  static async getInitialProps(ctx) {
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

```javascript
export default async function handler(req, res) {
  
}
```

## `nmid` - nextMiddleware

```javascript
import { NextResponse } from 'next/server'
export async function middleware(request) {
  
}

export const config = {
  matcher: '/about/:path*',
}
```

## Local mocked Horizon runs

The same helpers work from plain JavaScript test files (Jest with `ts-jest` compiles the TypeScript example). See [`docs/examples/mocked-horizon.ts`](examples/mocked-horizon.ts) and the TypeScript variants in [typescript-snippets.md](typescript-snippets.md#local-mocked-horizon-runs) (Issue #789).

### `mhz` - mockedHorizonTest

```js
const { createMockHorizon, fetchMockedAccount, loadAccountFixture } = require('../docs/examples/mocked-horizon');

jest.mock('@actions/core');

it('reads a funded account', async () => {
  const funded = loadAccountFixture('account-funded');
  const horizon = createMockHorizon({ [funded.account_id]: funded });
  const account = await fetchMockedAccount(horizon.fetchFn, funded.account_id);
  expect(account.account_id).toBe(funded.account_id);
});

it('treats a missing account as unfunded (404)', async () => {
  const horizon = createMockHorizon({});
  await expect(fetchMockedAccount(horizon.fetchFn, 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'))
    .rejects.toMatchObject({ statusCode: 404 });
});
```
