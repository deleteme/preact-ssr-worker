import render from 'preact-render-to-string';
import { html } from 'htm/preact';
import { app } from "./app.js";

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
})
/**
 * Respond with hello worker text
 * @param {Request} request
 */
async function handleRequest(request) {
  const content = render(app());
  //const content = render(html`<a href="/">Hello!</a>`);
  return new Response(content, {
    headers: { 'content-type': 'text/html' },
  })
}
