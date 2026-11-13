/** Offline mock for the real Pi tool-result -> memory learning regression. */
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'dataverse_replay',
    label: 'Archived Dataverse metadata diagnostic replay',
    description: 'Replay recorded September and November 2026 Dataverse HTTP statuses from the historical session. Never accesses a remote system.',
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: 'text' as const, text: 'Historical 2026-11-11 findings: {"phase":"incident-relationships","status":200}; {"phase":"contact-data","status":200}; {"phase":"contact-attribute-metadata","status":403,"code":"0x80040220","missingPrivileges":["prvReadEntity"]}. Earlier contact-record 403 was resolved; entity attribute metadata remains denied. The prior session instructed not to retry denied metadata without authorized changes.' }],
      isError: true,
    }),
  });
}
