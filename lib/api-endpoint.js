'use strict';

const KNOWN_API_ENDPOINTS = [
  'chat/completions',
  'responses',
  'messages',
  'models',
];

function normalizeEndpoint(endpoint) {
  return String(endpoint || '').trim().replace(/^\/+|\/+$/g, '');
}

function splitKnownEndpoint(pathname) {
  const normalizedPath = String(pathname || '').replace(/\/+$/, '');
  const lowerPath = normalizedPath.toLowerCase();
  for (const endpoint of KNOWN_API_ENDPOINTS) {
    const suffix = `/${endpoint}`;
    if (!lowerPath.endsWith(suffix)) continue;
    return {
      basePath: normalizedPath.slice(0, -suffix.length),
      endpoint,
    };
  }
  return { basePath: normalizedPath, endpoint: '' };
}

function detectConfiguredEndpoint(apiBase) {
  const raw = String(apiBase || '').trim();
  if (!raw) return '';
  try {
    return splitKnownEndpoint(new URL(raw).pathname).endpoint;
  } catch {
    return '';
  }
}

function buildVersionedEndpointUrl(apiBase, endpoint) {
  const rawBase = String(apiBase || '').trim();
  const normalizedEndpoint = normalizeEndpoint(endpoint);
  if (!rawBase) throw new Error('Missing API Base URL');
  if (!normalizedEndpoint) throw new Error('Missing API endpoint');

  const url = new URL(rawBase);
  const { basePath, endpoint: configuredEndpoint } = splitKnownEndpoint(url.pathname);
  let versionedBasePath = basePath.replace(/\/+$/, '');
  if (!configuredEndpoint && !/\/v\d+(?:\.\d+)?$/i.test(versionedBasePath)) {
    versionedBasePath = `${versionedBasePath}/v1`;
  }
  url.pathname = `${versionedBasePath}/${normalizedEndpoint}`.replace(/\/{2,}/g, '/');
  url.hash = '';
  return url.toString();
}

module.exports = {
  buildVersionedEndpointUrl,
  detectConfiguredEndpoint,
};
