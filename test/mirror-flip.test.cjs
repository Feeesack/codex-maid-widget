'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto');

function fixture() {
  const nodes = [], calls = [];
  const document = { createElement() {
    const classes = new Set();
    const node = { ownerDocument: document, parentNode: null, children: [], style: {},
      classList: { add(value) { classes.add(value); }, remove(value) { classes.delete(value); }, contains(value) { return classes.has(value); } },
      appendChild(child) { child.remove(); this.children.push(child); child.parentNode = this; },
      insertBefore(child, reference) { child.remove(); const index = this.children.indexOf(reference); assert.ok(index >= 0); this.children.splice(index, 0, child); child.parentNode = this; },
      remove() { if (this.parentNode) { const index = this.parentNode.children.indexOf(this); this.parentNode.children.splice(index, 1); this.parentNode = null; } },
    };
    nodes.push(node); return node;
  } };
  const character = document.createElement('div'), before = document.createElement('div'), image = document.createElement('img'), after = document.createElement('div');
  character.appendChild(before); character.appendChild(image); character.appendChild(after);
  character.style.transform = 'scale(1.05,.88)'; character.style.translate = '-48px 28px';
  image.style.transform = 'translateY(-1px) rotate(-.3deg)';
  const animate = (element, keyframes, options) => {
    const call = { element, keyframes, options, start: element.style.transform, current: element.style.transform, stopped: 0 };
    call.stop = () => { call.stopped++; element.style.transform = call.current; };
    calls.push(call); return call;
  };
  return { image, character, before, after, nodes, calls, animate };
}

for (const folder of ['', 'macos/']) {
  const sourcePath = path.join(__dirname, '..', folder, 'src/mirror-flip.js');
  const { create } = require(sourcePath);
  test(folder + 'mirror flip: initial orientation and repeated state do not call the animation library', () => {
    const f = fixture(), controller = create(f), plane = f.image.parentNode;
    assert.equal(plane.className, 'character-mirror-plane');
    assert.deepEqual(f.character.children, [f.before, plane, f.after]);
    controller.setMirrored(true);
    assert.equal(plane.style.transform, 'scaleX(-1)');
    controller.setMirrored(true); assert.equal(f.calls.length, 0);
    assert.equal(create(f), controller); assert.equal(f.nodes.length, 5);
  });
  test(folder + 'mirror flip: the official Motion API owns interpolation and commits interrupted poses', () => {
    const f = fixture(), controller = create(f), plane = f.image.parentNode;
    controller.setMirrored(false); controller.setMirrored(true);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].element, plane);
    assert.deepEqual(f.calls[0].keyframes, { transform: 'scaleX(-1)' });
    assert.deepEqual(f.calls[0].options, { duration: 0.22, ease: 'easeInOut' });
    f.calls[0].current = 'matrix(0.4,0,0,1,0,0)';
    controller.setMirrored(false);
    assert.equal(f.calls[0].stopped, 1);
    assert.equal(f.calls[1].start, 'matrix(0.4,0,0,1,0,0)', 'new animation receives the committed displayed pose');
    assert.deepEqual(f.calls[1].keyframes, { transform: 'scaleX(1)' });
    controller.setMirrored(false); assert.equal(f.calls.length, 2);
    assert.equal(f.character.style.transform, 'scale(1.05,.88)');
    assert.equal(f.character.style.translate, '-48px 28px');
    assert.equal(f.image.style.transform, 'translateY(-1px) rotate(-.3deg)');
  });
  test(folder + 'mirror flip: explicit initial cancels a turn; dispose stops the library and restores the image once', () => {
    const f = fixture(), controller = create(f), plane = f.image.parentNode;
    controller.setMirrored(false); controller.setMirrored(true); controller.setMirrored(false, { initial: true });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].stopped, 1); assert.equal(plane.style.transform, 'scaleX(1)');
    controller.setMirrored(true);
    controller.dispose(); controller.dispose(); controller.setMirrored(false);
    assert.equal(f.calls[1].stopped, 1); assert.equal(f.calls.length, 2);
    assert.deepEqual(f.character.children, [f.before, f.image, f.after]);
    assert.equal(f.character.classList.contains('mirror-flip-enabled'), false);
    assert.notEqual(create(f), controller);
  });
  test(folder + 'mirror flip: browser adapter obtains the vendored Motion global and requires it explicitly', () => {
    const f = fixture(), context = { Motion: { animate: f.animate } };
    vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
    const controller = context.MaidMirrorFlip.create({ image: f.image });
    controller.setMirrored(false); controller.setMirrored(true);
    assert.equal(f.calls.length, 1);
    assert.throws(() => create(), /mounted character image/);
    assert.throws(() => create({ image: fixture().image }), /Motion animate/);
  });
  test(folder + 'mirror flip: flat isolated CSS and adapter contain no custom timing or 3D algorithm', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', folder, 'src/mirror-flip.css'), 'utf8');
    const js = fs.readFileSync(sourcePath, 'utf8');
    assert.match(css, /\.character-mirror-plane\{position:absolute;inset:0;pointer-events:none;transform-origin:50% 50%\}/);
    assert.match(css, /\.widget\.is-mirrored \.character\.mirror-flip-enabled img\{scale:1 1\}/);
    assert.doesNotMatch(css, /prefers-reduced-motion|\.bubble|\.toolbar|animation\s*:|transition\s*:|perspective|rotateY/);
    assert.doesNotMatch(js, /requestAnimationFrame|setTimeout|setInterval|\.animate\(|perspective|rotateY/);
  });
  test(folder + 'mirror flip: vendored official mini and license match their pinned provenance', () => {
    const directory = path.join(__dirname, '..', folder, 'src/vendor/motion');
    const proof = JSON.parse(fs.readFileSync(path.join(directory, 'PROVENANCE.json')));
    const content = fs.readFileSync(path.join(directory, 'dom-mini-14.4.0.js'));
    assert.equal(content.length, 12300);
    assert.equal(crypto.createHash('sha256').update(content).digest('hex'), '79c06ff30e72bde4f4275066b1d2400bf5f29e045293ee5f23a64c6388e8fa1a');
    assert.equal(proof.sha256, crypto.createHash('sha256').update(content).digest('hex'));
    assert.equal(proof.license, 'MIT'); assert.equal(proof.version, '14.4.0');
    assert.equal(proof.commit, 'bcdd7f5377ffea0913a41894c177c0e6da473fd9');
    assert.equal(proof.licenseSha256, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, 'LICENSE.md'))).digest('hex'));
    const context = {}; vm.runInNewContext(content.toString(), context); assert.equal(typeof context.Motion.animate, 'function');
  });
}
test('mirror flip: Windows and macOS sources and official vendor files are identical', () => {
  for (const file of ['mirror-flip.js', 'mirror-flip.css', 'vendor/motion/dom-mini-14.4.0.js', 'vendor/motion/LICENSE.md', 'vendor/motion/PROVENANCE.json']) assert.equal(
    fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'),
    fs.readFileSync(path.join(__dirname, '../macos/src', file), 'utf8'));
});
