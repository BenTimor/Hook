// Hook Browser: chrome://hook.
//
// The point of this file is not its text. It proves the module pipeline:
// TypeScript under browser/overlay/src/hook/resources is compiled, packed and
// served from chrome://hook. Step 2 replaces it with the real surfaces.

const status = document.querySelector<HTMLParagraphElement>('#status');
if (status) {
  status.textContent =
      'The seam is live: overlay C++, resources and GN wiring all reach this page.';
}
