const test = require('node:test');
const assert = require('node:assert/strict');
const { spotifyPlaylist, publicLink, pauseVisible } = require('../js/grow.js');

test('Spotify accepts only full public playlist URLs and drops tracking parameters', () => {
  const id='0123456789ABCDEFGHIJKL';
  const expected={url:`https://open.spotify.com/playlist/${id}`,embed:`https://open.spotify.com/embed/playlist/${id}`};
  assert.deepEqual(spotifyPlaylist(expected.url+'?si=tracking#share'),expected);
  assert.deepEqual(spotifyPlaylist(`https://open.spotify.com/intl-en/playlist/${id}/`),expected);
  for(const url of ['',null,'javascript:alert(1)',`http://open.spotify.com/playlist/${id}`,`https://open.spotify.com.evil.test/playlist/${id}`,`https://user:password@open.spotify.com/playlist/${id}`,`https://open.spotify.com:444/playlist/${id}`,`https://open.spotify.com/track/${id}`,`https://open.spotify.com/playlist/${id}/extra`,'https://spotify.link/short','https://open.spotify.com/playlist/short']) assert.equal(spotifyPlaylist(url),null,String(url));
});

test('external book links require HTTPS and never accept embedded credentials', () => {
  assert.equal(publicLink('https://publisher.example.test/books/title'),'https://publisher.example.test/books/title');
  for(const url of ['',null,'javascript:alert(1)','data:text/html,hello','http://publisher.example.test/','https://user:password@publisher.example.test/','/relative'])assert.equal(publicLink(url),null,String(url));
});

test('the one-Sunday pause expires at Central midnight, not UTC midnight', () => {
  const pause={date:'2026-09-13'};
  assert.equal(pauseVisible(pause,new Date('2026-09-07T04:00:00Z')),true);
  assert.equal(pauseVisible(pause,new Date('2026-09-14T04:59:59Z')),true);
  assert.equal(pauseVisible(pause,new Date('2026-09-14T05:00:00Z')),false);
  assert.equal(pauseVisible(pause,new Date('2026-11-01T06:00:00Z')),false);
});

test('missing or impossible pause dates never produce an undated series exception', () => {
  for(const pause of [null,{}, {date:'2026-02-30'},{date:'2026-9-13'},{date:'next Sunday'}])assert.equal(pauseVisible(pause,new Date('2026-01-01T12:00:00Z')),false);
});
