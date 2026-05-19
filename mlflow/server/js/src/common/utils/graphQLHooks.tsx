/* eslint-disable no-restricted-imports */
import type { Observable } from '@apollo/client/core';
import { ApolloLink, type Operation, type NextLink, type FetchResult } from '@apollo/client/core';
import { getDefaultHeaders } from './FetchUtils';
// eslint-disable-next-line no-restricted-imports
export * from '@apollo/client';
export * from '@apollo/client/link/retry';
export * from '@apollo/client/testing';

export class DefaultHeadersLink extends ApolloLink {
  private cookieStr: string;

  constructor({ cookieStr }: { cookieStr: string }) {
    super();
    this.cookieStr = cookieStr;
  }

  request(operation: Operation, forward: NextLink): Observable<FetchResult> {
    // Read document.cookie fresh on every request so that SSO/auth cookies
    // set after the Apollo client was created (e.g. post-login) are included.
    const liveCookieStr = typeof document !== 'undefined' ? document.cookie : this.cookieStr;
    operation.setContext(({ headers = {} }) => ({
      headers: {
        ...headers,
        ...getDefaultHeaders(liveCookieStr),
      },
    }));

    return forward(operation);
  }
}
