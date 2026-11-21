// SPDX-License-Identifier: LicenseRef-Proprietary

/** What a review settings form says in the factory, where nobody edits it in the UI: an AI sets these values through the API (ADR 0007, #1108). */
export const FACTORY_READ_ONLY_NOTE =
  "These values are set through the API by the AI that configures the lanes: PUT /api/w/<workspace>/review-settings for the workspace defaults, PUT or DELETE /api/w/<workspace>/repositories/<repository id>/project/settings for a project. They cannot be changed here.";
