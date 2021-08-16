import { html } from "htm/preact";

console.log('app.js, imported html', html);

export function App(props) {
  console.log('App() called with props', JSON.stringify(props));
  const { params } = props;
  const page = params && params.page;
  return html`
    <header>
      <h1>
        app, <em>in html!</em>
      </h1>
      <nav>
        <a href="/">Home</a>
        <a href="/about">About</a>
      </nav>
    </header>
    <main>
      <h1>
        ${!params && 'Home'}
        ${page === 'about' && 'About'}
      </h1>
    </main>
    <br />
    ${page}
  `;
}
