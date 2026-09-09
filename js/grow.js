/* Public reading resources; external audio loads only on a visitor's action. */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.CreekGrow = api; api.init(root.document, root.CREEK_GROW_CONTENT || {}); }
}(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  function spotifyPlaylist(value) {
    try {
      var url = new URL(value);
      if (url.protocol !== 'https:' || url.hostname !== 'open.spotify.com' || url.port || url.username || url.password) return null;
      var match = url.pathname.match(/^\/(?:intl-[a-z]{2}\/)?playlist\/([A-Za-z0-9]{22})\/?$/);
      return match ? { url:'https://open.spotify.com/playlist/' + match[1], embed:'https://open.spotify.com/embed/playlist/' + match[1] } : null;
    } catch (_) { return null; }
  }
  function publicLink(value) {
    try { var url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch (_) { return null; }
  }
  function bookSearchText(value) { return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/['’‘]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }
  function dottedAcronyms(value) {
    var aliases = [];
    String(value || '').replace(/(?:^|[^\p{L}\p{N}.])((?:[a-z]\.){2,}[a-z]?)(?=$|[^\p{L}\p{N}.])/giu, function (match, acronym) {
      aliases.push(acronym.replace(/\./g, '')); return match;
    });
    return aliases.join(' ');
  }
  function approvedBooks(value, query) {
    var words=bookSearchText(query).split(' ').filter(Boolean);
    return (Array.isArray(value)?value:[]).filter(function(book){
      if(!book || book.approved!==true || typeof book.title!=='string' || !book.title.trim() || typeof book.author!=='string' || !book.author.trim())return false;
      // Keep spaced initials searchable while accepting compact author spellings such as CS Lewis.
      var authorAlias=bookSearchText(book.author).replace(/\b(?:[a-z] ){1,}[a-z]\b/g,function(initials){return initials.replace(/ /g,'')});
      // Title acronyms keep their printed wording and gain only a compact dotted-letter alias.
      var text=bookSearchText([book.title,book.subtitle,dottedAcronyms(book.title),dottedAcronyms(book.subtitle),book.author,authorAlias,book.category,book.note,book.reader].join(' '));
      return words.every(function(word){return text.indexOf(word)!==-1});
    });
  }
  function churchDate(now) { return new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(now || new Date()); }
  function validDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value+'T12:00:00Z')) && new Date(value+'T12:00:00Z').toISOString().slice(0,10) === value; }
  function pauseVisible(pause, now) { return !!(pause && validDate(pause.date) && churchDate(now) <= pause.date); }
  function displayedPassage(series, now) {
    series = series || {};
    var next = series.nextPassage, recent = series.currentPassage;
    if (next && typeof next.reference === 'string' && next.reference.trim() && validDate(next.date) && next.date >= churchDate(now)) return { reference: next.reference, date: next.date, upcoming: true };
    if (recent && typeof recent.reference === 'string' && recent.reference.trim() && validDate(recent.date) && recent.date <= churchDate(now)) return { reference: recent.reference, date: recent.date, upcoming: false };
    return null;
  }
  function init(doc, content) {
    var screen = doc.querySelector('[data-screen="grow"]');
    if (!screen) return;
    function set(id, value) { var node=doc.getElementById(id); if(node && typeof value === 'string')node.textContent=value; }
    var series=content.series || {}, spotify=content.spotify || {};
    set('growSeriesTitle',series.title);set('homeSeriesTitle',series.title);set('growSeriesSubtitle',series.subtitle);set('growSeriesIntroduction',series.introduction);
    function updateDatedContent() {
      var passage = displayedPassage(series);
      doc.getElementById('growCurrent').hidden = !passage;
      if (passage) {
        set('growPassageLabel', passage.upcoming ? 'Next in the series' : 'Where we are');
        set('growCurrentReference', passage.reference);
        set('growCurrentDate', (passage.upcoming ? 'Scheduled passage · ' : 'Most recent passage · ') + new Date(passage.date+'T12:00:00Z').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric',timeZone:'UTC'}));
      }
      doc.getElementById('growPause').hidden = !pauseVisible(series.pause);
    }
    if(series.pause){set('growPauseTitle',series.pause.title);set('growPauseDescription',series.pause.description)}
    updateDatedContent(); doc.addEventListener('visibilitychange',updateDatedContent);
    // Recheck after a long-open overnight session, not only on a full reload.
    doc.defaultView.setInterval(updateDatedContent,60000);
    screen.querySelectorAll('[data-grow-scroll]').forEach(function(button){button.addEventListener('click',function(){var target=doc.getElementById(button.dataset.growScroll);if(target){target.scrollIntoView({behavior:'auto',block:'start'});var heading=target.querySelector('h3');if(heading){heading.tabIndex=-1;heading.focus({preventScroll:true})}}})});
    set('growSpotifyTitle',spotify.title);set('growSpotifyDescription',spotify.description);
    var playlist=spotifyPlaylist(spotify.playlistUrl), player=doc.getElementById('growSpotifyPlayer'), load=doc.getElementById('growSpotifyLoad'), close=doc.getElementById('growSpotifyClose');
    if(playlist) {
      doc.getElementById('growSpotifyPending').hidden=true;doc.getElementById('growSpotifyActions').hidden=false;
      doc.getElementById('growSpotifyLink').href=playlist.url;
      load.addEventListener('click',function(){
        if(player.querySelector('iframe'))return;
        var frame=doc.createElement('iframe');frame.src=playlist.embed;frame.title='Spotify playlist: '+(spotify.title||'Bluff Creek');frame.width='100%';frame.height='352';frame.allow='encrypted-media; fullscreen; picture-in-picture';frame.referrerPolicy='strict-origin-when-cross-origin';
        player.appendChild(frame);player.hidden=false;close.hidden=false;
        load.textContent='Player opened below';load.setAttribute('aria-disabled','true');
        set('growSpotifyStatus','Press play in Spotify to listen. If the player is unavailable, use Open in Spotify.');
      });
      close.addEventListener('click',function(){player.replaceChildren();player.hidden=true;close.hidden=true;load.textContent='Load Spotify player';load.removeAttribute('aria-disabled');set('growSpotifyStatus','The player is closed.');load.focus()});
    }
    var shelf=doc.getElementById('growBooks'), books=approvedBooks(content.books), cards=[];
    books.forEach(function(book,i){
      var article=doc.createElement('article');article.className='grow-book';var number=doc.createElement('span');number.className='book-number';number.setAttribute('aria-hidden','true');number.textContent=String(i+1).padStart(2,'0');article.appendChild(number);
      var body=doc.createElement('div'), heading=doc.createElement('h4');heading.textContent=book.title;body.appendChild(heading);
      if(typeof book.subtitle==='string' && book.subtitle.trim()){var subtitle=doc.createElement('p');subtitle.className='book-subtitle';subtitle.textContent=book.subtitle;body.appendChild(subtitle)}
      var author=doc.createElement('div');author.className='book-author';author.textContent=book.author;body.appendChild(author);
      if(typeof book.note==='string' && book.note.trim()){var note=doc.createElement('p');note.textContent=book.note;body.appendChild(note)}
      if(typeof book.context==='string' && book.context.trim()){
        var details=doc.createElement('details');details.className='book-context';var summary=doc.createElement('summary');summary.textContent='Reading context';details.appendChild(summary);
        if(typeof book.reader==='string' && book.reader.trim()){var reader=doc.createElement('p');reader.textContent='Good for: '+book.reader;details.appendChild(reader)}
        var context=doc.createElement('p');context.textContent=book.context;details.appendChild(context);body.appendChild(details);
        if(typeof book.edition==='string' && book.edition.trim()){var edition=doc.createElement('p');edition.textContent='Edition: '+book.edition;details.appendChild(edition)}
      }
      var url=publicLink(book.url);if(url){var link=doc.createElement('a');link.href=url;link.target='_blank';link.rel='noopener noreferrer';link.textContent='About this book ↗';link.setAttribute('aria-label','About this book: '+book.title);body.appendChild(link)}
      article.appendChild(body);shelf.appendChild(article);cards.push({book:book,node:article});
    });
    doc.getElementById('growBooksPending').hidden=books.length>0;
    var tools=doc.getElementById('growBookTools'), search=doc.getElementById('growBookSearch'), clear=doc.getElementById('growBookClear');
    if(tools && search && clear){
      tools.hidden=books.length===0;
      function filterShelf(){
        var visible=approvedBooks(books,search.value);
        cards.forEach(function(card){card.node.hidden=visible.indexOf(card.book)===-1});
        set('growBookCount',visible.length+' '+(visible.length===1?'book':'books')+(search.value.trim()?' found':' on the shelf'));
        doc.getElementById('growBooksEmpty').hidden=visible.length>0 || books.length===0;
        clear.hidden=!search.value;
      }
      search.addEventListener('input',filterShelf);clear.addEventListener('click',function(){search.value='';filterShelf();search.focus()});filterShelf();
    }
  }
  return { spotifyPlaylist:spotifyPlaylist, publicLink:publicLink, pauseVisible:pauseVisible, displayedPassage:displayedPassage, approvedBooks:approvedBooks, init:init };
}));
