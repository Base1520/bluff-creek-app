const test = require('node:test');
const assert = require('node:assert/strict');
const { spotifyPlaylist, publicLink, pauseVisible, displayedPassage, approvedBooks } = require('../js/grow.js');

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

test('book search finds subtitles, coauthors and topics despite punctuation or word order', () => {
  const books=[
    {approved:true,title:'Don’t Waste Your Life',author:'John Piper',note:'Following Jesus every day'},
    {approved:true,title:'How to Read the Bible Book by Book',subtitle:'A Guided Tour',author:'Gordon D. Fee and Douglas Stuart',category:'Bible study'}
  ];
  for(const query of ["don't waste",'PIPER life','Jesus'])assert.deepEqual(approvedBooks(books,query),[books[0]]);
  for(const query of ['Stuart','tour guided','Bible study'])assert.deepEqual(approvedBooks(books,query),[books[1]]);
  assert.deepEqual(approvedBooks(books,'   '),books);
  assert.deepEqual(approvedBooks(books,'no matching book'),[]);
});

test('book searches never expose unapproved or incomplete recommendations', () => {
  const approved={approved:true,title:'Approved book',author:'Author'};
  const candidates=[approved,{approved:false,title:'Hidden book',author:'Author'},{approved:'true',title:'Hidden book',author:'Author'},{approved:true,title:'Missing author'},null];
  assert.deepEqual(approvedBooks(candidates),[approved]);
  assert.deepEqual(approvedBooks(candidates,'hidden'),[]);
  assert.deepEqual(approvedBooks(null),[]);
});

test('author initials match compact, spaced and dotted spellings without changing query tokens', () => {
  const books=[
    {approved:true,title:'Synthetic selection one',author:'C. S. Lewis'},
    {approved:true,title:'Synthetic selection two',author:'A. W. Tozer'},
    {approved:true,title:'Synthetic selection three',author:'J. I. Packer'},
    {approved:true,title:'Synthetic selection four',author:'R. C. Sproul'}
  ];
  for(const [index,queries] of [
    [0,['CS Lewis','C.S. Lewis','C S Lewis','lewis cs']],
    [1,['AW Tozer','A.W. Tozer','A W Tozer']],
    [2,['JI Packer','J.I. Packer','J I Packer']],
    [3,['RC Sproul','R.C. Sproul','R C Sproul']]
  ])for(const query of queries)assert.deepEqual(approvedBooks(books,query),[books[index]],query);
  assert.deepEqual(approvedBooks(books,'CS Lewis missing'),[],'every query word must still match');
  assert.deepEqual(approvedBooks(books,'cs tozer'),[],'initial aliases must belong to the same author');
});

test('compact-initial aliases cannot expose unapproved books or join unrelated search text', () => {
  const approved={approved:true,title:'Synthetic approved selection',author:'C. S. Lewis'};
  const books=[approved,{approved:false,title:'Synthetic hidden selection',author:'C. S. Lewis'},
    {approved:'true',title:'Synthetic unreviewed selection',author:'C. S. Lewis'},
    {approved:true,title:'Synthetic unrelated selection',author:'Single Author',note:'C S notes'}];
  assert.deepEqual(approvedBooks(books,'CS Lewis'),[approved]);
  assert.deepEqual(approvedBooks(books,'CS hidden'),[]);
  assert.deepEqual(approvedBooks(books,'CS unrelated'),[],'only author initials receive an alias');
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


test('upcoming sermon stays scheduled through its Central date and never becomes preached history automatically', () => {
  const series={nextPassage:{reference:'Habakkuk 1:2–4',date:'2026-09-20'},currentPassage:null};
  assert.deepEqual(displayedPassage(series,new Date('2026-09-21T04:59:59Z')),{reference:'Habakkuk 1:2–4',date:'2026-09-20',upcoming:true});
  assert.equal(displayedPassage(series,new Date('2026-09-21T05:00:00Z')),null);
  series.currentPassage={reference:'Confirmed older passage',date:'2026-09-06'};
  assert.equal(displayedPassage(series,new Date('2026-09-21T05:00:00Z')).upcoming,false);
});
test('invalid or future most-recent passages are not represented as preached sermons', () => {
  const now=new Date('2026-09-07T18:00:00Z');
  for(const currentPassage of [{reference:'Future',date:'2026-09-20'},{reference:'Impossible',date:'2026-02-30'},{reference:' ',date:'2026-09-06'},null])assert.equal(displayedPassage({currentPassage},now),null);
});
