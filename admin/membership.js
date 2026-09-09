(function(root){
  'use strict';
  function sheetLink(value){try{var u=new URL(value);return u.protocol==='https:' && u.hostname==='docs.google.com' && !u.username && !u.password && /^\/spreadsheets\/d\/[A-Za-z0-9_-]+\/(?:edit)?$/.test(u.pathname)?u.origin+u.pathname:null}catch(_){return null}}
  function create(options){
    var host=options.root,doc=host.ownerDocument,rows=[],loadId=0,selected='',previewURL=null,dialog=null,requestId=0,failed=false,ready=false,draft=null,loadedOwner=null,unloadListening=false;
    host.innerHTML='<div class="panel membership-intro"><p class="eyebrow">The membership archive</p><h2>Every name has a story.</h2><p>Keep the original pages, preserve uncertain dates, and follow each person’s history through the life of the church.</p><p id="membership-sheet-note" class="membership-note">The existing Google ledger remains your working source. Google account access applies; changes in Creek Office do not sync to Google Sheets.</p><a id="membership-sheet-link" class="membership-sheet-button" target="_blank" rel="noopener noreferrer" hidden>Open membership spreadsheet ↗</a></div><div class="membership-controls"><select id="membership-person" aria-label="Choose a person’s history"><option value="">All people</option></select><input id="membership-search" type="search" placeholder="Search history, dates or source pages" aria-label="Search membership history"><button id="membership-add" type="button">Add history / page photo</button></div><p class="membership-note" id="membership-status" role="status"></p><div class="panel membership-history" id="membership-history"></div>';
    var find=function(id){return host.querySelector('#'+id)};
    var ledger=sheetLink(options.sheetUrl);
    find('membership-sheet-link').onclick=function(event){if(!writable()||!ledger||event.currentTarget.getAttribute('href')!==ledger)event.preventDefault()};
    function clearSheetLink(){find('membership-sheet-link').hidden=true;find('membership-sheet-link').removeAttribute('href')}
    function context(){return options.getContext()}
    function active(epoch,owner){var c=context();return c.epoch===epoch && options.isCurrent(epoch) && !!c.userId && (!owner || c.userId===owner) && ['admin','editor'].includes(c.role)}
    function writable(){var c=context();return active(c.epoch)&&c.canEdit===true&&c.workspaceReady!==false&&ready&&!failed}
    function deadline(promise){var timer;return Promise.race([Promise.resolve(promise),new Promise(function(_,reject){timer=doc.defaultView.setTimeout(function(){reject(new Error('timeout'))},12000)})]).finally(function(){doc.defaultView.clearTimeout(timer)})}
    function authError(e){return e&&(['42501','PGRST301','PGRST302'].includes(e.code)||[401,403].includes(e.status))}
    function sameDraft(d){return draft===d&&active(d.epoch,d.owner)}
    async function gate(d){if(!sameDraft(d))throw new Error('session');if(options.ensureReady && await deadline(options.ensureReady(d.epoch))===false)throw new Error('unavailable');if(!sameDraft(d))throw new Error('session');if(!writable())throw new Error('unavailable')}
    function syncForm(){syncUnload();if(!dialog||!draft)return;var locked=draft.pending||draft.uncertain||!!draft.snapshot;dialog.querySelectorAll('input,select,textarea').forEach(function(n){n.disabled=locked || (draft.correction&&n.name==='contact_id')});dialog.querySelectorAll('[data-close]').forEach(function(n){n.disabled=draft.pending||draft.uncertain||draft.unresolvedWrites>0||(draft.uploaded&&!draft.filed)});var save=dialog.querySelector('[type=submit]');if(save)save.disabled=draft.pending||draft.uncertain||!writable();var retry=dialog.querySelector('[data-recover]');if(retry)retry.disabled=draft.pending||context().workspaceReady===false;}
    function check(epoch){if(!active(epoch))throw new Error('Your session changed. Sign in again before saving.')}
    function name(person){return [person.last_name,person.first_name,person.middle_name].filter(Boolean).join(', ')}
    function peopleOptions(select,placeholder){var value=select.value;select.replaceChildren(new Option(placeholder,''));options.people().forEach(function(p){select.add(new Option(name(p)+(p.membership_number?' · #'+p.membership_number:''),p.id))});select.value=value}
    function formFingerprint(){if(!dialog)return '';return JSON.stringify(Array.from(dialog.querySelectorAll('form [name]')).map(function(n){return[n.name,n.type==='file'?Array.from(n.files||[]).map(function(f){return[f.name||'',f.type,f.size]}):n.type==='checkbox'?n.checked:n.value]}))}
    // Best-effort browser warning only; drafts and photos remain in memory.
    function warnUnload(event){event.preventDefault();event.returnValue=true}
    function syncUnload(){var needed=!!(draft&&(draft.pending||draft.uncertain||draft.unresolvedWrites>0||draft.snapshot||(draft.uploaded&&!draft.filed)||(draft.initialForm&&formFingerprint()!==draft.initialForm)));if(needed===unloadListening)return;doc.defaultView[needed?'addEventListener':'removeEventListener']('beforeunload',warnUnload);unloadListening=needed}
    function closeDialog(force){if(force!==true&&draft&&(draft.pending||draft.uncertain||draft.unresolvedWrites>0||(draft.uploaded&&!draft.filed)))return;if(force!==true&&draft&&draft.initialForm&&formFingerprint()!==draft.initialForm&&!doc.defaultView.confirm(draft.filed?'Discard this review draft? The uploaded source page will remain in Documents.':'Discard this unsaved review? Your transcription and selected photo will be cleared.'))return;requestId++;draft=null;syncUnload();if(previewURL){URL.revokeObjectURL(previewURL);previewURL=null}if(dialog){if(dialog.open)dialog.close();dialog.remove();dialog=null}}
    function clear(){clearSheetLink();loadId++;rows=[];selected='';failed=false;ready=false;loadedOwner=null;closeDialog(true);find('membership-person').replaceChildren(new Option('All people',''));find('membership-search').value='';find('membership-history').replaceChildren();find('membership-status').textContent=''}
    async function load(epoch){
      if(!active(epoch)){clear();return}if(loadedOwner&&loadedOwner!==context().userId)clear();loadedOwner=context().userId;var currentLoad=++loadId,all=[],total=null,seen=new Set();failed=false;
      try{for(var offset=0;;){
        if(!active(epoch)||currentLoad!==loadId)return;
        var query=options.db.from('membership_history').select('*',{count:'exact'}).order('created_at',{ascending:false}).order('id',{ascending:true}),paged=typeof query.range==='function';
        var result=await deadline(paged?query.range(offset,offset+999):query);
        if(!active(epoch)||currentLoad!==loadId)return;if(result&&result.error)throw result.error;
        if(!result||!Array.isArray(result.data)||!Number.isSafeInteger(result.count)||result.count<0||(total!==null&&result.count!==total))throw new Error('Incomplete history response');
        total=result.count;
        if(all.length+result.data.length>total)throw new Error('Incomplete history response');
        result.data.forEach(function(row){if(!row||typeof row.id!=='string'||!row.id.trim()||seen.has(row.id))throw new Error('Incomplete history response');seen.add(row.id)});
        all=all.concat(result.data);offset=all.length;
        if(offset===total)break;
        if(!paged||!result.data.length)throw new Error('Incomplete history response');
      }rows=all;ready=true;render()}catch(error){if(active(epoch)&&currentLoad===loadId){if(authError(error)){clear();return}rows=[];ready=false;failed=true;render();find('membership-status').textContent='History could not load. Your review draft is retained; restore the connection before saving.'}}
    }
    function render(){
      clearSheetLink();if(writable()&&ledger){find('membership-sheet-link').href=ledger;find('membership-sheet-link').hidden=false}
      if(!active(context().epoch)){clear();return}if(loadedOwner&&loadedOwner!==context().userId){clear();return}peopleOptions(find('membership-person'),'All people');if(selected)find('membership-person').value=selected;
      if(dialog&&!draft&&!writable())closeDialog(true);
      var person=find('membership-person').value,term=find('membership-search').value.trim().toLowerCase(),people=new Map(options.people().map(function(p){return[p.id,p]}));
      var filtered=rows.filter(function(r){return(!person||r.contact_id===person)&&(!term||[name(people.get(r.contact_id)||{}),r.event_type,r.event_date,r.date_text,r.details,r.source_label].join(' ').toLowerCase().includes(term))});
      var area=find('membership-history');area.replaceChildren();find('membership-add').disabled=!writable();syncForm();
      find('membership-status').textContent=filtered.length+' history entries'+(filtered.length>100?' · showing the first 100; narrow the search to see more':'')+'. Corrections keep the original entry.';
      if(!filtered.length){var blank=doc.createElement('p');blank.className='membership-blank';blank.textContent=failed?'History is unavailable.':'No history entries match. Add a verified entry or a photographed source page to begin.';area.appendChild(blank)}
      filtered.slice(0,100).forEach(function(r){var a=doc.createElement('article');a.className='membership-entry';var owner=doc.createElement('small');owner.textContent=name(people.get(r.contact_id)||{})||'Member record';a.appendChild(owner);var title=doc.createElement('h3');title.textContent=r.event_type+' · '+(r.date_text||r.event_date||'Date not yet confirmed');a.appendChild(title);if(r.details){var body=doc.createElement('p');body.textContent=r.details;a.appendChild(body)}var source=doc.createElement('small');source.textContent='Source: '+(r.source_label||'Not recorded')+(r.corrects_id?' · Correction to an earlier entry':'');a.appendChild(source);
        if(r.source_document_id){var original=doc.createElement('button');original.className='quiet';original.textContent='Open original page';original.onclick=function(){openSource(r.source_document_id)};a.appendChild(original)}
        var correction=doc.createElement('button');correction.className='quiet';correction.textContent='Add correction';correction.onclick=function(){openForm(r)};a.appendChild(correction);area.appendChild(a)});
    }
    async function openSource(id){var epoch=context().epoch,owner=context().userId;if(!writable()||draft)return;closeDialog();var req=requestId;dialog=doc.createElement('dialog');dialog.className='membership-dialog';dialog.setAttribute('aria-label','Original membership page');var title=doc.createElement('h2');title.textContent='Original page';var resultNode=doc.createElement('p');resultNode.textContent='Preparing a private link…';var close=doc.createElement('button');close.textContent='Close';close.onclick=closeDialog;dialog.append(title,resultNode,close);doc.body.appendChild(dialog);dialog.addEventListener('cancel',function(e){e.preventDefault();closeDialog()});dialog.showModal();
      function currentSource(){if(req!==requestId)return false;if(!active(epoch,owner)||!writable()){if(!draft)closeDialog(true);return false}return true}
      try{var record=await deadline(options.db.from('documents').select('storage_path').eq('id',id).maybeSingle());if(!currentSource())return;if(record.error)throw record.error;if(!record.data)throw new Error();var signed=await deadline(options.db.storage.from('church-documents').createSignedUrl(record.data.storage_path,60));if(!currentSource())return;if(signed.error)throw signed.error;var url=options.documentUrl?options.documentUrl(signed.data.signedUrl):new URL(signed.data.signedUrl);if(url.username||url.password||(!options.documentUrl&&url.protocol!=='https:')||!['http:','https:'].includes(url.protocol))throw new Error();var link=doc.createElement('a');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open the original page (link expires in one minute)';resultNode.replaceChildren(link);doc.defaultView.setTimeout(function(){if(req===requestId&&dialog)resultNode.textContent='This link has expired. Close and reopen for a fresh link.'},60000)}catch(error){if(currentSource()){if(authError(error)){clear();return}resultNode.textContent='Could not open the private source page. Try again after checking access.'}}}
    function openForm(correction){if(!writable()||draft)return;closeDialog();var epoch=context().epoch,formRequest=requestId;draft={id:doc.defaultView.crypto.randomUUID(),documentId:doc.defaultView.crypto.randomUUID(),epoch:epoch,owner:context().userId,correction:correction||null,pending:false,uncertain:false,snapshot:null,uploadPath:null,file:null,uploaded:false,filed:false};dialog=doc.createElement('dialog');dialog.className='membership-dialog';dialog.setAttribute('aria-labelledby','history-form-title');dialog.innerHTML='<header><div><p class="eyebrow">Preserve the record</p><h2 id="history-form-title">'+(correction?'Add a correction':'Add history or a page photo')+'</h2></div><button type="button" class="quiet" data-close>Close</button></header><p class="membership-note">Keep uncertain handwriting exactly as it appears, using [unclear] where needed. Review the transcription against the page before saving. A page photo is not automatically transcribed here.</p><form><div class="form-grid"><label class="wide">Person<select name="contact_id" required></select></label><label>Event or record type<input name="event_type" required maxlength="160" placeholder="Baptism, joined by letter, dismissal…"></label><label>Verified date (optional)<input name="event_date" type="date"></label><label class="wide">Date as written / approximate date<input name="date_text" maxlength="500" placeholder="e.g. Summer 1964; day unclear"></label><label class="wide">Source / book and page<input name="source_label" required maxlength="500" placeholder="Membership book, page number"></label><label class="wide">Transcription and historical details<textarea name="details" maxlength="10000" placeholder="Preserve the original wording. Mark uncertain letters or dates."></textarea></label><label class="wide">Existing source document (optional)<select name="existing_source"><option value="">No existing document</option></select></label><label class="wide">Original page photo (optional)<input name="page" type="file" accept="image/jpeg,image/png,image/webp" capture="environment"><span class="membership-note">JPEG, PNG or WebP · up to 15 MB. For a new person, add their People record first.</span></label></div><img class="page-preview" alt="Selected original page for transcription review" hidden><label class="review-check"><input name="reviewed" type="checkbox" required><span>I checked this entry against its source and marked anything uncertain.</span></label><output role="alert"></output><button class="quiet" type="button" data-recover>Check saved progress / retry connection</button><footer><button class="quiet" type="button" data-close>Cancel</button><button type="submit">Save reviewed history</button></footer></form>';
      var form=dialog.querySelector('form'),select=form.elements.contact_id;var existing=form.elements.existing_source;(options.documents?options.documents():[]).forEach(function(d){existing.add(new Option(d.title,d.id))});if(correction&&correction.source_document_id){if(!Array.from(existing.options).some(function(o){return o.value===correction.source_document_id}))existing.add(new Option('Original source for this entry',correction.source_document_id));existing.value=correction.source_document_id;}peopleOptions(select,'Choose a person');select.value=correction?correction.contact_id:find('membership-person').value;if(correction){select.disabled=true;['event_type','event_date','date_text','source_label','details'].forEach(function(k){form.elements[k].value=correction[k]||''})}
      dialog.querySelectorAll('[data-close]').forEach(function(b){b.onclick=closeDialog});dialog.addEventListener('cancel',function(e){e.preventDefault();closeDialog()});
      form.addEventListener('input',syncUnload,true);form.addEventListener('change',syncUnload,true);
      form.elements.page.onchange=function(){if(previewURL)URL.revokeObjectURL(previewURL);previewURL=null;var img=dialog.querySelector('img'),file=form.elements.page.files[0];img.hidden=true;img.removeAttribute('src');if(file&&['image/jpeg','image/png','image/webp'].includes(file.type)&&file.size<=15728640){previewURL=URL.createObjectURL(file);img.src=previewURL;img.hidden=false}};
      var d=draft;
      d.unresolvedWrites=0;d.writeRevision=0;
      function output(message){if(sameDraft(d)&&dialog)form.querySelector('output').textContent=message}
      // A client deadline does not cancel the underlying request or prove server absence.
      async function write(promise){
        var unresolved=true,timedOut=false;d.unresolvedWrites++;
        function settled(){
          unresolved=false;d.unresolvedWrites--;d.writeRevision++;
          if(timedOut&&sameDraft(d)){d.uncertain=true;output('An earlier save request finished. Check saved progress again before continuing.');syncForm()}
        }
        var observed=Promise.resolve(promise).then(function(result){settled();return result},function(error){settled();throw error});
        try{return await deadline(observed)}catch(error){if(unresolved)timedOut=true;throw error}
      }
      function snapshot(){
        if(!form.reportValidity())return false;
        var personId=correction?correction.contact_id:select.value,eventType=form.elements.event_type.value.trim(),source=form.elements.source_label.value.trim(),file=form.elements.page.files[0];
        if(!options.people().some(function(p){return p.id===personId}))throw new Error('Choose a current person record.');
        if(!eventType||!source||!form.elements.reviewed.checked)throw new Error('Enter an event type and source, then confirm your source review.');
        if(file&&(!['image/jpeg','image/png','image/webp'].includes(file.type)||!file.size||file.size>15728640))throw new Error('Choose a JPEG, PNG or WebP image up to 15 MB.');
        d.file=file||null;
        d.snapshot={id:d.id,contact_id:personId,event_type:eventType,event_date:form.elements.event_date.value||null,date_text:form.elements.date_text.value.trim()||null,details:form.elements.details.value.trim()||null,source_label:source,source_document_id:form.elements.existing_source.value||null,corrects_id:correction?correction.id:null};
        if(file){var suffix={'image/jpeg':'jpg','image/png':'png','image/webp':'webp'}[file.type];d.uploadPath=d.owner+'/membership-history/'+d.documentId+'.'+suffix;d.metadata={id:d.documentId,title:'Membership source · '+source,category:'other',description:'Original membership source page. Retain with historical records.',storage_path:d.uploadPath,file_name:'membership-source.'+suffix,mime_type:file.type,size_bytes:file.size,uploaded_by:d.owner};}
        return true;
      }
      function confirmed(result,id){if(result.error)throw result.error;if(!result.data||result.data.id!==id)throw new Error('unconfirmed');return result.data}
      async function success(recovered){
        if(!sameDraft(d))return;
        closeDialog(true);
        if(active(d.epoch,d.owner))options.notice(recovered?'This reviewed history was already saved. Open the entry to review it. The Google ledger has not been changed.':'Reviewed history saved. The Google ledger has not been changed.');
        try{if(options.refresh)await options.refresh()}catch(_){if(active(d.epoch,d.owner))options.notice('History was saved, but the workspace could not refresh. Refresh it when the connection returns.',true)}
      }
      async function recover(){
        if(!sameDraft(d)||d.pending)return;var revision=d.writeRevision;d.pending=true;syncForm();output('Checking the saved history and source page…');
        function changedDuringCheck(){if(d.writeRevision===revision)return false;d.uncertain=true;output('An earlier save request finished during this check. Check saved progress again to confirm the latest result.');return true}
        try{
          if(options.ensureReady && await deadline(options.ensureReady(d.epoch))===false)throw new Error('unavailable');
          if(!sameDraft(d))return;
          if(context().workspaceReady===false)throw new Error('unavailable');
          var history=await deadline(options.db.from('membership_history').select('*').eq('id',d.id).maybeSingle());
          if(!sameDraft(d))return;if(history.error)throw history.error;
          if(history.data){if(history.data.id!==d.id||!d.snapshot||history.data.contact_id!==d.snapshot.contact_id)throw new Error('unconfirmed');if(changedDuringCheck())return;await success(true);return;}
          if(d.file){
            var metadata=await deadline(options.db.from('documents').select('id,storage_path').eq('id',d.documentId).maybeSingle());
            if(!sameDraft(d))return;if(metadata.error)throw metadata.error;
            if(metadata.data){if(metadata.data.id!==d.documentId||metadata.data.storage_path!==d.uploadPath)throw new Error('unconfirmed');d.uploaded=true;d.filed=true;d.snapshot.source_document_id=d.documentId;}
            else if(!d.uploaded){
              var parts=d.uploadPath.split('/'),filename=parts.pop();
              var files=await deadline(options.db.storage.from('church-documents').list(parts.join('/'),{search:filename,limit:100}));
              if(!sameDraft(d))return;if(files.error)throw files.error;
              d.uploaded=(files.data||[]).some(function(row){return row.name===filename});
            }
          }
          if(!ready||failed)await load(d.epoch);
          if(!sameDraft(d))return;
          if(changedDuringCheck())return;
          d.uncertain=false;
          output(d.unresolvedWrites>0?'An earlier save is still unresolved. Keep this draft open. You can retry with the same record and upload IDs, then check saved progress again.':d.filed?'The original page is safely filed in Documents. Save reviewed history to finish; the same source will be reused.':d.uploaded?'The page upload is present. Save reviewed history to finish filing it; it will not be uploaded again.':'No saved history was found. Your reviewed draft is retained; retry uses the same record and upload IDs.');
        }catch(error){if(sameDraft(d)){if(authError(error)){clear();return}output('Saved progress could not be confirmed. Your submitted draft and photo are retained. Restore the connection, then check again.');}}
        finally{if(sameDraft(d)){d.pending=false;syncForm()}}
      }
      form.querySelector('[data-recover]').onclick=recover;
      form.onsubmit=async function(e){
        e.preventDefault();if(!sameDraft(d)||d.pending||d.uncertain)return;
        if(!writable()){output('Restore the workspace connection before saving. Your draft and photo are retained.');syncForm();return}
        try{if(!d.snapshot&&!snapshot())return}catch(error){output(error.message);return}
        d.pending=true;syncForm();output('Saving the reviewed entry…');var mutationStarted=false;
        try{
          await gate(d);
          if(d.file&&!d.uploaded){mutationStarted=true;var uploaded=await write(options.db.storage.from('church-documents').upload(d.uploadPath,d.file,{contentType:d.file.type,upsert:false}));if(!sameDraft(d))return;if(uploaded.error)throw uploaded.error;d.uploaded=true;}
          if(d.file&&!d.filed){await gate(d);mutationStarted=true;var metadata=await write(options.db.from('documents').insert(d.metadata).select('id').single());if(!sameDraft(d))return;confirmed(metadata,d.documentId);d.filed=true;d.snapshot.source_document_id=d.documentId;}
          await gate(d);mutationStarted=true;var result=await write(options.db.from('membership_history').insert(d.snapshot).select('id').single());if(!sameDraft(d))return;confirmed(result,d.id);await success(false);
        }catch(error){
          if(sameDraft(d)){
            if(authError(error)){clear();return}
            d.uncertain=mutationStarted;
            output(mutationStarted?'The save could not be confirmed. Your submitted review is locked to prevent duplicate or changed entries. Check saved progress before trying again.':'The connection is unavailable. Your reviewed draft and photo are retained. Restore the connection before retrying.');
          }
        }finally{if(sameDraft(d)){d.pending=false;syncForm()}}
      };d.initialForm=formFingerprint();doc.body.appendChild(dialog);dialog.showModal();syncForm();
    }
    find('membership-person').onchange=function(){selected=find('membership-person').value;render()};find('membership-search').oninput=render;find('membership-add').onclick=function(){openForm()};
    return{load:load,render:render,clear:clear,selectPerson:function(id){selected=id;find('membership-person').value=id;find('membership-search').value='';render();location.hash='history'}};
  }
  root.CreekMembership={create:create,sheetLink:sheetLink};
}(typeof window!=='undefined'?window:globalThis));
