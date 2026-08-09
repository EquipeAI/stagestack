/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as cfp from "../cfp.js";
import type * as cfpPublic from "../cfpPublic.js";
import type * as contacts from "../contacts.js";
import type * as crons from "../crons.js";
import type * as emails from "../emails.js";
import type * as events from "../events.js";
import type * as http from "../http.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_validators from "../lib/validators.js";
import type * as library from "../library.js";
import type * as model_audit from "../model/audit.js";
import type * as model_cfp from "../model/cfp.js";
import type * as model_comms from "../model/comms.js";
import type * as model_contacts from "../model/contacts.js";
import type * as model_events from "../model/events.js";
import type * as model_jobs from "../model/jobs.js";
import type * as model_library from "../model/library.js";
import type * as model_orgs from "../model/orgs.js";
import type * as model_slugs from "../model/slugs.js";
import type * as model_team from "../model/team.js";
import type * as orgs from "../orgs.js";
import type * as shared_formDef from "../shared/formDef.js";
import type * as shared_jobTypes from "../shared/jobTypes.js";
import type * as team from "../team.js";
import type * as users from "../users.js";
import type * as worker from "../worker.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  cfp: typeof cfp;
  cfpPublic: typeof cfpPublic;
  contacts: typeof contacts;
  crons: typeof crons;
  emails: typeof emails;
  events: typeof events;
  http: typeof http;
  "lib/functions": typeof lib_functions;
  "lib/validators": typeof lib_validators;
  library: typeof library;
  "model/audit": typeof model_audit;
  "model/cfp": typeof model_cfp;
  "model/comms": typeof model_comms;
  "model/contacts": typeof model_contacts;
  "model/events": typeof model_events;
  "model/jobs": typeof model_jobs;
  "model/library": typeof model_library;
  "model/orgs": typeof model_orgs;
  "model/slugs": typeof model_slugs;
  "model/team": typeof model_team;
  orgs: typeof orgs;
  "shared/formDef": typeof shared_formDef;
  "shared/jobTypes": typeof shared_jobTypes;
  team: typeof team;
  users: typeof users;
  worker: typeof worker;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  resend: import("@convex-dev/resend/_generated/component.js").ComponentApi<"resend">;
  rateLimiter: import("@convex-dev/rate-limiter/_generated/component.js").ComponentApi<"rateLimiter">;
};
