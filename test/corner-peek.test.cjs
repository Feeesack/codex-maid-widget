'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
for (const [platform, modulePath] of [['Windows', '../src/settings.cjs'], ['macOS', '../macos/src/settings.cjs']]) {
  const { sanitize, snapBounds, bottomCorner, widgetDimensions, cornerPeekOffset, projectVisualBounds, mirrorForBounds } = require(modulePath);
  test(platform + ': peeking is opt-in and survives sanitization', () => {
    assert.equal(sanitize().peekAtCorners, false);
    assert.equal(sanitize({peekAtCorners:true}).peekAtCorners, true);
    assert.equal(sanitize({peekAtCorners:'true'}).peekAtCorners, false);
    assert.equal(sanitize().stayInCodexWindow, false);
  });
  test(platform + ': only the two bottom corners attract a nearby character', () => {
    const area = { x:-1200, y:100, width:1200, height:900 }, size = {width:228,height:288};
    const position = (x,y) => snapBounds({x,y,...size},area);
    assert.deepEqual(position(-1190,702), {x:-1200,y:712,mirror:true});
    assert.deepEqual(position(-238,702), {x:-228,y:712,mirror:false});
    for (const [x,y] of [[-1190,110],[-238,110],[-1190,400],[-238,400],[-700,702],[-700,110]]) {
      const p = position(x,y); assert.equal(p.x,x); assert.equal(p.y,y);
      assert.equal(bottomCorner({...p,...size},area),null);
    }
    assert.equal(bottomCorner({x:-1200,y:712,...size},area),'left');
    assert.equal(bottomCorner({x:-228,y:712,...size},area),'right');
    assert.equal(bottomCorner({x:-227,y:713,...size},area),'right','one DIP of native rounding is harmless');
    assert.equal(bottomCorner({x:-228,y:708,...size},area),null,'pulling away leaves the dock');
  });
  test(platform + ': corner peeking hides the side and bottom in proportion to the preferred size', () => {
    assert.deepEqual(cornerPeekOffset(null,{width:380,height:480}), {x:0,y:0});
    assert.deepEqual(cornerPeekOffset('left',{width:380,height:480}), {x:-48,y:56});
    assert.deepEqual(cornerPeekOffset('right',{width:380,height:480}), {x:48,y:56});
    for (const scale of [0.6,1,1.25,1.5,1.6]) {
      const size = widgetDimensions(scale), factor = size.width/380;
      assert.deepEqual(cornerPeekOffset('left',size),{x:-48*factor,y:56*factor});
      assert.deepEqual(cornerPeekOffset('right',size),{x:48*factor,y:56*factor});
    }
  });
  test(platform + ': projecting a docked pose clips both edges without changing the preferred size', () => {
    const area = {x:-1536,y:-120,width:1536,height:864};
    for (const scale of [0.6,1,1.25,1.5,1.6]) {
      const size = widgetDimensions(scale);
      for (const corner of ['left','right']) {
        const origin = {x:corner==='left'?area.x:area.x+area.width-size.width,y:area.y+area.height-size.height};
        const peek = cornerPeekOffset(corner,size);
        const visual = {x:origin.x+peek.x,y:origin.y+peek.y,...size};
        const projected = projectVisualBounds(visual,area);
        assert.deepEqual(projected.bounds,{...origin,...size});
        assert.ok(corner==='left'?projected.offset.x<0:projected.offset.x>0);
        assert.ok(projected.offset.y>0);
        assert.equal(projected.bounds.x+projected.offset.x,visual.x);
        assert.equal(projected.bounds.y+projected.offset.y,visual.y);
      }
    }
  });
  test(platform + ': downward and upward dragging follow the same visual origin through the clipped boundary', () => {
    const area = {x:-1200,y:100,width:1200,height:900}, size = {width:228,height:288};
    const baseline = area.y+area.height-size.height;
    for (const originX of [area.x-28.8,area.x+area.width-size.width+28.8]) {
      for (const deltas of [[0,0.25,5.5,20,40], [40,20,5.5,0.25,0,-15,-80]]) {
        let previous = null;
        for (const delta of deltas) {
          const visual = {x:originX,y:baseline+33.6+delta,...size};
          const {bounds,offset} = projectVisualBounds(visual,area);
          const world = {x:bounds.x+offset.x,y:bounds.y+offset.y};
          assert.equal(world.x,visual.x);
          assert.equal(world.y,visual.y,'native clamping cannot pull a downward pointer move upward');
          assert.equal(bounds.width,size.width);
          assert.equal(bounds.height,size.height);
          if (previous) assert.ok(Math.abs((world.y-previous.y)-(delta-previous.delta))<1e-10);
          previous = {...world,delta};
        }
      }
    }
  });
  test(platform + ': crossing between corners preserves fractional world coordinates and mirror direction', () => {
    const area = {x:-1440,y:-360,width:1440,height:900}, size = {width:285,height:360};
    const xs = [area.x-36,area.x+0.25,-1000.5,-720.5,-500.25,-285.25,-249];
    let previous = -Infinity;
    for (const x of xs) {
      const visual = {x,y:area.y+area.height-size.height+42.125,...size};
      const {bounds,offset} = projectVisualBounds(visual,area);
      const worldX = bounds.x+offset.x;
      assert.equal(worldX,x);
      assert.ok(worldX>previous,'left-to-right dragging never reverses at either clamp');
      assert.equal(bounds.y+offset.y,visual.y);
      assert.deepEqual({width:bounds.width,height:bounds.height},size);
      assert.equal(mirrorForBounds(visual,area),x+size.width/2<area.x+area.width/2);
      previous=worldX;
    }
  });
}
