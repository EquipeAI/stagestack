/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agenda from "../agenda.js";
import type * as cfp from "../cfp.js";
import type * as cfpPublic from "../cfpPublic.js";
import type * as comms from "../comms.js";
import type * as contacts from "../contacts.js";
import type * as crons from "../crons.js";
import type * as emails from "../emails.js";
import type * as embeds from "../embeds.js";
import type * as events from "../events.js";
import type * as headshotProcessing from "../headshotProcessing.js";
import type * as headshotUploads from "../headshotUploads.js";
import type * as http from "../http.js";
import type * as imports from "../imports.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_urls from "../lib/urls.js";
import type * as lib_validators from "../lib/validators.js";
import type * as library from "../library.js";
import type * as model_agenda from "../model/agenda.js";
import type * as model_audiences from "../model/audiences.js";
import type * as model_audit from "../model/audit.js";
import type * as model_cfp from "../model/cfp.js";
import type * as model_comms from "../model/comms.js";
import type * as model_contacts from "../model/contacts.js";
import type * as model_controlCenter from "../model/controlCenter.js";
import type * as model_embeds from "../model/embeds.js";
import type * as model_events from "../model/events.js";
import type * as model_headshotImages from "../model/headshotImages.js";
import type * as model_ics from "../model/ics.js";
import type * as model_imports from "../model/imports.js";
import type * as model_jobs from "../model/jobs.js";
import type * as model_library from "../model/library.js";
import type * as model_orgs from "../model/orgs.js";
import type * as model_portal from "../model/portal.js";
import type * as model_publish from "../model/publish.js";
import type * as model_readiness from "../model/readiness.js";
import type * as model_reviews from "../model/reviews.js";
import type * as model_sessions from "../model/sessions.js";
import type * as model_slugs from "../model/slugs.js";
import type * as model_speakers from "../model/speakers.js";
import type * as model_tasks from "../model/tasks.js";
import type * as model_team from "../model/team.js";
import type * as model_templates from "../model/templates.js";
import type * as model_userDisplay from "../model/userDisplay.js";
import type * as model_validation from "../model/validation.js";
import type * as orgs from "../orgs.js";
import type * as portal from "../portal.js";
import type * as publish from "../publish.js";
import type * as readiness from "../readiness.js";
import type * as reminders from "../reminders.js";
import type * as reviews from "../reviews.js";
import type * as sessions from "../sessions.js";
import type * as shared_brandColor from "../shared/brandColor.js";
import type * as shared_bulkDecisions from "../shared/bulkDecisions.js";
import type * as shared_formDef from "../shared/formDef.js";
import type * as shared_importPlan from "../shared/importPlan.js";
import type * as shared_jobTypes from "../shared/jobTypes.js";
import type * as shared_reminderSchedule from "../shared/reminderSchedule.js";
import type * as shared_scorecard from "../shared/scorecard.js";
import type * as shared_sessionContent from "../shared/sessionContent.js";
import type * as speakers from "../speakers.js";
import type * as tasks from "../tasks.js";
import type * as team from "../team.js";
import type * as templates from "../templates.js";
import type * as users from "../users.js";
import type * as worker from "../worker.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agenda: typeof agenda;
  cfp: typeof cfp;
  cfpPublic: typeof cfpPublic;
  comms: typeof comms;
  contacts: typeof contacts;
  crons: typeof crons;
  emails: typeof emails;
  embeds: typeof embeds;
  events: typeof events;
  headshotProcessing: typeof headshotProcessing;
  headshotUploads: typeof headshotUploads;
  http: typeof http;
  imports: typeof imports;
  "lib/functions": typeof lib_functions;
  "lib/urls": typeof lib_urls;
  "lib/validators": typeof lib_validators;
  library: typeof library;
  "model/agenda": typeof model_agenda;
  "model/audiences": typeof model_audiences;
  "model/audit": typeof model_audit;
  "model/cfp": typeof model_cfp;
  "model/comms": typeof model_comms;
  "model/contacts": typeof model_contacts;
  "model/controlCenter": typeof model_controlCenter;
  "model/embeds": typeof model_embeds;
  "model/events": typeof model_events;
  "model/headshotImages": typeof model_headshotImages;
  "model/ics": typeof model_ics;
  "model/imports": typeof model_imports;
  "model/jobs": typeof model_jobs;
  "model/library": typeof model_library;
  "model/orgs": typeof model_orgs;
  "model/portal": typeof model_portal;
  "model/publish": typeof model_publish;
  "model/readiness": typeof model_readiness;
  "model/reviews": typeof model_reviews;
  "model/sessions": typeof model_sessions;
  "model/slugs": typeof model_slugs;
  "model/speakers": typeof model_speakers;
  "model/tasks": typeof model_tasks;
  "model/team": typeof model_team;
  "model/templates": typeof model_templates;
  "model/userDisplay": typeof model_userDisplay;
  "model/validation": typeof model_validation;
  orgs: typeof orgs;
  portal: typeof portal;
  publish: typeof publish;
  readiness: typeof readiness;
  reminders: typeof reminders;
  reviews: typeof reviews;
  sessions: typeof sessions;
  "shared/brandColor": typeof shared_brandColor;
  "shared/bulkDecisions": typeof shared_bulkDecisions;
  "shared/formDef": typeof shared_formDef;
  "shared/importPlan": typeof shared_importPlan;
  "shared/jobTypes": typeof shared_jobTypes;
  "shared/reminderSchedule": typeof shared_reminderSchedule;
  "shared/scorecard": typeof shared_scorecard;
  "shared/sessionContent": typeof shared_sessionContent;
  speakers: typeof speakers;
  tasks: typeof tasks;
  team: typeof team;
  templates: typeof templates;
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
