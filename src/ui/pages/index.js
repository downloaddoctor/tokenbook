// Pages registry. Router expects each entry to expose { mount, unmount }.
// Swap any for a Preact component later without touching the router.

import * as register from './register.js';
import * as tokens from './tokens.js';
import * as patients from './patients.js';
import * as printLayout from './printLayout.js';

export const Pages = { register, tokens, patients, printLayout };
