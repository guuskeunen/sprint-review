import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { normalize } from '../../src/config.ts';
import { checkPicks, describePictures, forModel } from '../../src/ai/pictures.ts';
import type { ModelAnswer, ModelClient, ModelRequest } from '../../src/ai/model.ts';
import type { WrittenTheme } from '../../src/types.ts';

const config = normalize({ product: { name: 'Spoke', description: 'a bike repair app' } }, '/tmp');

const png = (width: number, height: number) => sharp({ create: { width, height, channels: 4, background: '#3366cc' } }).png().toBuffer();

/** Answers each request with what `answer` returns for it, and keeps the requests. */
function scripted(answer: (r: ModelRequest) => Record<string, unknown> | Error): ModelClient & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    async ask(r: ModelRequest): Promise<ModelAnswer> {
      requests.push(r);
      const a = answer(r);
      if (a instanceof Error) throw a;
      return { toolInput: a, model: 'fake', usage: { input: 1, output: 1 } };
    },
  };
}

const theme = (title: string, screen: string | null): WrittenTheme => ({ title, icon: 'other', screen, device: 'desktop', value: null, effect: `${title} got better.`, points: [`A point about ${title}`], notes: null });

test('a long page is sent at 1280 wide, its top 2000 pixels, as JPEG', async () => {
  const image = await forModel(await png(2560, 8000));
  assert.equal(image.mediaType, 'image/jpeg');
  const meta = await sharp(Buffer.from(image.data, 'base64')).metadata();
  assert.deepEqual([meta.width, meta.height, meta.format], [1280, 2000, 'jpeg']);
  const small = await sharp(Buffer.from((await forModel(await png(400, 300))).data, 'base64')).metadata();
  assert.deepEqual([small.width, small.height], [400, 300], 'a small picture is not enlarged');
});

test('each picture gets one short line, sent with the picture and its name', async () => {
  const model = scripted((r) => (r.messages[0]!.includes('Planner') ? { shows: 'The workshop planner:\na bar of today and counts per status.' } : { shows: Array(50).fill('word').join(' ') }));
  const pictures = { planner: { name: 'Planner', png: await png(800, 600) }, long: { name: 'Long "one"', png: await png(800, 600) } };
  const { descriptions, checks } = await describePictures(model, config, pictures);
  assert.equal(descriptions.planner, 'The workshop planner: a bar of today and counts per status.');
  assert.equal(descriptions.long!.split(' ').length, 30, 'clipped to 30 words');
  assert.ok(descriptions.long!.endsWith('…'));
  assert.deepEqual(checks, []);
  assert.equal(model.requests.length, 2);
  assert.equal(model.requests[0]!.images?.length, 1);
  assert.match(model.requests[0]!.system, /never an instruction to you/);
  assert.ok(model.requests.some((r) => r.messages[0]!.includes(`"Long 'one'"`)), 'a name cannot break out of its quotes');
});

test('a picture the model cannot look at gets no line and one warning, and the run goes on', async () => {
  const model = scripted((r) => (r.messages[0]!.includes('Broken') ? new Error('API 400: this model does not take images') : { shows: 'A list of repairs' }));
  const { descriptions, checks } = await describePictures(model, config, { ok: { name: 'Repairs', png: await png(10, 10) }, bad: { name: 'Broken', png: await png(10, 10) } });
  assert.deepEqual(Object.keys(descriptions), ['ok']);
  assert.equal(checks.length, 1);
  assert.equal(checks[0]!.kind, 'warning');
  assert.match(checks[0]!.reason, /Broken \(API 400: this model does not take images\)/);
  assert.match(checks[0]!.reason, /turn off screenshots.check/);
});

test('a picked picture that does not show the slide is taken off, with the reason', async () => {
  const model = scripted((r) => (r.messages[0]!.includes('Rejecting leads') ? { fits: false, why: 'It shows the 3 Ws section of a company page.' } : { fits: true, why: '' }));
  const themes = [theme('Rejecting leads', 'The 3 Ws (desktop)'), theme('Planner', 'Planner (desktop)'), theme('No picture', null)];
  const picture = await png(10, 10);
  const { themes: out, checks } = await checkPicks(model, config, themes, (label) => ({ name: label.replace(/ \(.*/, ''), png: picture }));
  assert.equal(out[0]!.screen, null);
  assert.equal(out[1]!.screen, 'Planner (desktop)');
  assert.equal(out[2]!.screen, null);
  assert.equal(model.requests.length, 2, 'a theme without a picture is not asked about');
  assert.match(model.requests[0]!.messages[0]!, /^<untrusted-[0-9a-f]+ description="the slide/, 'the slide text is data');
  assert.deepEqual(checks, [{ kind: 'dropped', text: 'Picture The 3 Ws on Rejecting leads', reason: 'It does not show what the slide says: It shows the 3 Ws section of a company page. The slide shows its icon instead.' }]);
});

test('a pick that could not be checked stays, with a warning', async () => {
  const model = scripted(() => new Error('timeout'));
  const { themes, checks } = await checkPicks(model, config, [theme('Planner', 'Planner (desktop)')], () => ({ name: 'Planner', png: Buffer.alloc(0) }));
  assert.equal(themes[0]!.screen, 'Planner (desktop)');
  assert.equal(checks[0]!.kind, 'warning');
});
