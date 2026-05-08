// Content script — injected into mail.google.com.
//
// In U6a this is an empty stub so we can verify the content script is
// being loaded correctly via the manifest. U6b adds the compose-window
// hook (mint + pixel injection) and U6c adds the self-view beacon. The
// manifest is registered in U6a so neither of those units has to touch
// it.

console.log('email-tracker content script loaded');
