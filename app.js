import { html } from "htm/preact";

console.log('app.js, imported html', html);

export function App(props) {
  console.log('App() called with props', JSON.stringify(props));
  const { params } = props;
  return html`
    <header>
      <h1>
        app, <em>in html!</em>
      </h1>
      <nav>
        <a href="/">Home</a>
        <a href="/page">Page</a>
      </nav>
    </header>
    <br />
    ${params && params.page}
  `;
}
