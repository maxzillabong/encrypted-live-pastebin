#!/usr/bin/env node
/**
 * Build script for LivePaste
 * - Extracts inline JS from HTML
 * - Minifies JS with terser (mangle, compress, remove comments)
 * - Minifies CSS
 * - Minifies HTML
 * - Outputs production-ready single-file HTML
 */

const fs = require('fs');
const path = require('path');
const { minify: minifyJS } = require('terser');

const SRC_FILE = path.join(__dirname, 'src', 'index.html');
const OUT_FILE = path.join(__dirname, 'public', 'index.html');

async function build() {
  console.log('Building LivePaste...');

  // Read source HTML
  let html = fs.readFileSync(SRC_FILE, 'utf8');

  // Extract and minify inline JavaScript
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (scriptMatch) {
    const originalJS = scriptMatch[1];
    console.log(`  JS source: ${(originalJS.length / 1024).toFixed(1)} KB`);

    const minified = await minifyJS(originalJS, {
      compress: {
        dead_code: true,
        drop_console: false, // Keep console for error reporting
        drop_debugger: true,
        passes: 2,
      },
      mangle: {
        toplevel: false, // Don't mangle top-level to preserve globals
        properties: false,
      },
      format: {
        comments: false, // Strip all comments
      },
    });

    if (minified.error) {
      console.error('Terser error:', minified.error);
      process.exit(1);
    }

    console.log(`  JS minified: ${(minified.code.length / 1024).toFixed(1)} KB (${((1 - minified.code.length / originalJS.length) * 100).toFixed(0)}% reduction)`);

    // Replace original JS with minified (use function to avoid $ substitution issues)
    html = html.replace(/<script>[\s\S]*?<\/script>(\s*<\/body>)/, (match, closingBody) => {
      return `<script>${minified.code}</script>${closingBody}`;
    });
  }

  // Minify inline CSS
  const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
  if (styleMatch) {
    const originalCSS = styleMatch[1];
    console.log(`  CSS source: ${(originalCSS.length / 1024).toFixed(1)} KB`);

    // Basic CSS minification (remove comments, whitespace)
    const minifiedCSS = originalCSS
      .replace(/\/\*[\s\S]*?\*\//g, '') // Remove comments
      .replace(/\s+/g, ' ')              // Collapse whitespace
      .replace(/\s*([{}:;,>+~])\s*/g, '$1') // Remove space around punctuation
      .replace(/;}/g, '}')               // Remove trailing semicolons
      .trim();

    console.log(`  CSS minified: ${(minifiedCSS.length / 1024).toFixed(1)} KB (${((1 - minifiedCSS.length / originalCSS.length) * 100).toFixed(0)}% reduction)`);

    html = html.replace(/<style>[\s\S]*?<\/style>/, `<style>${minifiedCSS}</style>`);
  }

  // Remove HTML comments and collapse whitespace (simple, no parser)
  const originalHTMLSize = html.length;
  html = html
    .replace(/<!--[\s\S]*?-->/g, '')  // Remove HTML comments
    .replace(/>\s+</g, '><')          // Remove whitespace between tags
    .replace(/\n\s*\n/g, '\n')        // Collapse multiple newlines
    .trim();

  console.log(`  HTML: ${(originalHTMLSize / 1024).toFixed(1)} KB -> ${(html.length / 1024).toFixed(1)} KB`);

  // Write output
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, html);

  console.log(`\nBuild complete: ${OUT_FILE}`);
  console.log(`Total size: ${(html.length / 1024).toFixed(1)} KB`);
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
