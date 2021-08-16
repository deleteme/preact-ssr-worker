import { html } from "./html.js";

export function App(props = {}) {
  console.log('App() called with props', JSON.stringify(props));
  const { params } = props;
  console.log('params', params);
  const page = params && params.page;
  return html`
    <header>
      <h1>
        app, <em>in html!</em>
      </h1>
      <nav>
        <a href="/">Home</a>
        <a href="/pages/about">About</a>
      </nav>
    </header>
    <main>
      <h1>
        ${!params && 'Home'}
        ${page === 'about' && 'About'}
      </h1>
      ${page}
    </main>
    <footer>foot</footer>
  `;
}
