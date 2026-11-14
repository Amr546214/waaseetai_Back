import test from 'node:test';
import assert from 'node:assert/strict';
import {TOKEN_REGISTRY,tokensOfKey} from '../config/site-identity-tokens';
import {validateTokenValue,buildTokensCss,TokenRejected} from './site-identity-tokens';
test('presentation defaults are sparse: untouched roles emit no CSS',()=>{assert.equal(buildTokensCss({}),'');const def=TOKEN_REGISTRY.find(t=>t.name==='--type-h1-size')!;assert.equal(def.dark,'inherit');assert.equal(def.preservesDefault,true);assert.deepEqual(validateTokenValue('tokens.typography',{'--type-h1-size':'inherit'},{allowEmpty:true}).value,{});});
test('presentation fields use the correct key and strict numeric bounds',()=>{assert.deepEqual(validateTokenValue('tokens.typography',{'--type-h1-size':'32px','--type-h1-weight':'700'}).value,{'--type-h1-size':'32px','--type-h1-weight':'700'});for(const value of ['-1px','9999px','var(--x)','1px;display:none'])assert.throws(()=>validateTokenValue('tokens.typography',{'--type-h1-size':value}),TokenRejected);assert.throws(()=>validateTokenValue('tokens.components',{'--type-h1-size':'32px'}),TokenRejected);});
test('component and level identity never introduces financial policy fields',()=>{const defs=tokensOfKey('tokens.components');assert.equal(defs.length,350);assert.ok(defs.every(d=>!/(?:commission|cashback|balance|points|threshold)/i.test(d.name)));assert.ok(buildTokensCss({'tokens.components':{'--comp-card-radius':'20px'}}).includes('--comp-card-radius:20px'));});
test('palette dark override is pinned away from the light theme and defaults drop',()=>{const d=tokensOfKey('tokens.palette.dark')[0];assert.deepEqual(validateTokenValue('tokens.palette.dark',{[d.name]:d.dark},{allowEmpty:true}).value,{});const css=buildTokensCss({'tokens.palette.dark':{[d.name]:'#ff0000'}});assert.ok(css.includes(d.name+':#ff0000'));assert.ok(css.includes(d.name+':'+d.dark));assert.ok(css.includes('.theme-light'));});
test('a multi-place group has one extra token per place and field (independent control); single-place groups have none; names stay valid and unique',()=>{
	const {placeTokenName,presentationPlaces}=require('../config/site-identity-tokens') as typeof import('../config/site-identity-tokens');
	const names=new Set(TOKEN_REGISTRY.map(t=>t.name));
	assert.equal(presentationPlaces('.a,.b , [data-x="1,2"]').length,3);
	const btn=TOKEN_REGISTRY.find(t=>t.name==='--comp-button-height')!;
	assert.ok(btn,'a button token exists'); assert.ok(names.has(placeTokenName(btn.name,0))&&names.has(placeTokenName(btn.name,1))&&names.has(placeTokenName(btn.name,2)),'one token per place of «الأزرار»'); assert.ok(!names.has(placeTokenName(btn.name,3)));
	const h1=TOKEN_REGISTRY.find(t=>t.name==='--type-h1-size')!; assert.ok(!names.has(placeTokenName(h1.name,0)),'a single-place group gets no per-place token');
	const place=TOKEN_REGISTRY.find(t=>t.name===placeTokenName(btn.name,1))!; assert.equal(place.type,btn.type); assert.equal(place.dark,'inherit'); assert.equal(place.preservesDefault,true); assert.match(place.label,/الموضع 2/);
	// a value for ONE place is accepted by the real validator, and a bad one is refused with the same rule as the group's token
	const key=btn.scope==='typography'?'tokens.typography':'tokens.components'; const good=btn.type==='length'?'40px':btn.type==='number'?'1':'#ffffff';
	assert.deepEqual(validateTokenValue(key,{[place.name]:good}).value,{[place.name]:good});
	assert.throws(()=>validateTokenValue(key,{[place.name]:'url(x)'}),TokenRejected);
	assert.throws(()=>validateTokenValue(key,{[placeTokenName(btn.name,9)]:good}),TokenRejected);
});
