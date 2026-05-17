# Add React Component Tests For Profile Save And Discard

## Goal

Add focused React component coverage for persisted profile form save/discard behavior from the UI Quality backlog item:

- `ProfileForm` should prove that editing a persisted profile field enables the actions, saving sends the updated profile payload through `useUpdateProfileMutation`, resets the dirty state to the persisted response, and shows the saved status.
- `ProfileForm` should prove that discarding after an edit restores the originally provided persisted value, disables the actions again, and does not call the update API.
- `SettingsForm` should prove the same save/reset interaction for persisted settings fields through `useUpdateSettingsMutation`.

The scope stays inside `apps/web/src/contexts/profile/forms/`. This is a test-only change; it must not redesign the profile UI or change production form behavior unless a test exposes a real defect that blocks the backlog item.

## Current Evidence

- `docs/backlog.md` says the gap is specifically that profile form folders have axe-only coverage for this behavior and mutation hooks are tested in isolation, but no test drives save/reset interactions through the rendered forms.
- `apps/web/src/contexts/profile/forms/profile-form.test.tsx` already contains component tests for visible profile and preference editor behavior, so adding interaction cases there is the lowest-friction path for `ProfileForm`.
- `apps/web/src/contexts/profile/forms/settings-form.tsx` has no colocated component test yet, only a11y coverage, so the settings interaction coverage should be added as `settings-form.test.tsx`.
- Existing test helpers already support this without new infrastructure:
  - `renderWithProviders`
  - `buildTestPorts({ api: { updateProfile, updateSettings } })`
  - `sampleProfileResponse`
  - `sampleSettingsResponse`

## Proposed Implementation

1. Extend `profile-form.test.tsx` with two component tests.
   - Save path:
     - Render `<ProfileForm initial={sampleProfileResponse} />` with a fake `updateProfile`.
     - Edit a visible persisted field such as `Full name`.
     - Assert `save all` and `discard all` become enabled.
     - Click `save all`.
     - Assert the fake API receives a request whose serialized `profileText` contains the edited `personal.full_name`.
     - Return a response with the edited full name and assert `profile saved` appears and the action buttons return to disabled.
   - Discard path:
     - Render with a fake `updateProfile`.
     - Edit the same visible persisted field.
     - Click `discard all`.
     - Assert the field value returns to `sampleProfileResponse.profile.personal.full_name`, buttons are disabled, and `updateProfile` was not called.

2. Add `settings-form.test.tsx` beside `settings-form.tsx`.
   - Save path:
     - Render `<SettingsForm initial={sampleSettingsResponse.settings} />` with a fake `updateSettings`.
     - Edit a persisted field such as `Target role`.
     - Assert `save` and `reset` become enabled.
     - Click `save`.
     - Assert `updateSettings` receives the edited `targetRole`.
     - Return a `SettingsResponse` containing the edited role, then assert `settings saved` appears and actions are disabled.
   - Reset path:
     - Render with a fake `updateSettings`.
     - Edit `Target role`.
     - Click `reset`.
     - Assert the field returns to `sampleSettingsResponse.settings.targetRole`, actions are disabled, and `updateSettings` was not called.

3. Keep assertions user-facing where possible.
   - Prefer labels and button names over implementation selectors.
   - Only inspect serialized payloads at the API boundary where the form intentionally submits `profileText`, `styleText`, and `templateText`.

## Rejected Alternatives

- Do not add broad E2E coverage for this backlog item. The defect surface is local form state plus mutation wiring, and component tests can isolate it without requiring the API server or browser workflow.
- Do not add tests to the mutation hook specs for this gap. Those already cover hook-level success/rollback behavior and cannot prove the rendered form save/reset controls work together.
- Do not introduce new MSW handlers or global test providers. Existing port injection gives precise API assertions with less setup.
- Do not redesign the profile editor controls or change form labels as part of this work. That would broaden a test backlog item into UI behavior work.

## Verification

Run the narrow web component tests first:

```sh
pnpm --filter @jobhunter/web test -- profile-form.test.tsx settings-form.test.tsx
```

If the narrow command passes, run the profile context web test surface if time allows:

```sh
pnpm --filter @jobhunter/web test -- src/contexts/profile
```

No README or architecture documentation updates are expected because this is a test-only backlog item with no product behavior, API, command, or architecture change.

## Risks And Notes

- The `ProfileForm` test depends on stable accessible labels from `StructuredProfileEditor`. If labels differ from the expected field names, use the current accessible label rather than adding test IDs.
- The save tests should wait for status messages or disabled button state to avoid racing TanStack Form's async submit state.
- TODO: If implementation reveals that reset leaves fields dirty after `form.reset(...)`, fix the production form behavior in the same small scope and keep the new component test as the regression guard.
