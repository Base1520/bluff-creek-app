/* Private guest spreadsheet link and recoverable guest-visit removal. */
(function (root) {
  'use strict';
  function create(options) {
    var doc=options.root.ownerDocument, token=0, owner=null, epoch=null, available=false, settings=null, dialog=null, operation=null;
    function context(){return options.getContext()||{};}
    function identity(){var c=context();return !!owner&&c.userId===owner&&c.epoch===epoch&&['admin','editor'].includes(c.role)&&options.isCurrent(epoch);}
    function current(){return identity()&&context().canEdit&&context().workspaceReady!==false;}
    function admin(){return current()&&context().role==='admin';}
    function removed(row){return !!(row&&(row.guest_removed_at||row.status==='archived'));}
    function changed(){if(options.onChange)options.onChange();}
    function deadline(p){var timer;return Promise.race([Promise.resolve(p),new Promise(function(_r,reject){timer=root.setTimeout(function(){reject(new Error('timeout'));},12000);})]).finally(function(){root.clearTimeout(timer);});}
    function close(){if(dialog){if(dialog.open)dialog.close();dialog.remove();dialog=null;}}
    function beforeUnload(event){if(operation){event.preventDefault();event.returnValue=true;}}
    function clear(){token++;owner=null;epoch=null;available=false;settings=null;operation=null;close();root.removeEventListener('beforeunload',beforeUnload);}
    function unavailable(){token++;available=false;settings=null;close();}
    function validUrl(value){try{var u=new URL(value);return u.protocol==='https:'&&u.hostname==='docs.google.com'&&!u.port&&!u.username&&!u.password&&/^\/spreadsheets\/d\/[A-Za-z0-9_-]{20,200}\/edit$/.test(u.pathname)&&!u.search&&!u.hash;}catch(_){return false;}}
    async function load(nextEpoch){
      var c=context();if(c.epoch!==nextEpoch||!c.userId||!['admin','editor'].includes(c.role)){clear();return false;}
      if(owner!==c.userId||epoch!==c.epoch){clear();owner=c.userId;epoch=c.epoch;}
      if(!current()){unavailable();return false;}
      var id=++token;
      var result=await Promise.allSettled([deadline(options.db.rpc('get_guest_lifecycle_readiness',{})),deadline(options.db.rpc('get_guest_sheet_settings',{}))]);
      if(id!==token||!current())return false;
      var cap=result[0].status==='fulfilled'?result[0].value:null, sheet=result[1].status==='fulfilled'?result[1].value:null;
      available=!!(cap&&!cap.error&&cap.data&&cap.data.version===1&&cap.data.available===true);
      settings=sheet&&!sheet.error&&sheet.data&&sheet.data.version===1&&Number.isSafeInteger(sheet.data.settings_version)&&sheet.data.settings_version>=0&&(sheet.data.sheet_url===null||validUrl(sheet.data.sheet_url))?sheet.data:null;
      changed();return available;
    }
    function button(text,action){var b=doc.createElement('button');b.type='button';b.className='quiet';b.textContent=text;b.onclick=action;return b;}
    function toolbar(host){
      host.replaceChildren();if(!current())return;
      var p=doc.createElement('p');p.className='signup-note';
      if(settings&&settings.sheet_url){var link=doc.createElement('a');link.className='button quiet';link.textContent='Open guest spreadsheet';link.href=settings.sheet_url;link.target='_blank';link.rel='noopener noreferrer';host.appendChild(link);p.textContent='The spreadsheet shows a copy of the guest register. Make changes here in Office. Check its last successful sync before relying on the copy.';}
      else p.textContent='Google spreadsheet: '+(settings?'no guest spreadsheet linked yet.':'connection setup is not available yet.');
      host.appendChild(p);
      if(admin()&&settings){var setup=button(settings.sheet_url?'Change spreadsheet link':'Link guest spreadsheet',openSettings);setup.disabled=!!operation;host.appendChild(setup);}
      if(operation){var status=doc.createElement('p');status.className='signup-note';status.setAttribute('role','status');status.textContent=operation.busy?'Saving guest-visit change…':'The guest-visit change could not be confirmed. Retry the same request to check its result.';host.appendChild(status);var retry=button('Retry same guest-visit change',function(){run(operation);});retry.disabled=operation.busy||!admin()||!available;host.appendChild(retry);}
    }
    function rowAction(host,row){
      if(!admin()||!available||!row||!Number.isSafeInteger(row.guest_lifecycle_version)||row.guest_lifecycle_version<1)return;
      var b=button(removed(row)?'Restore guest visit':'Remove guest visit',function(){openRemoval(row);});b.dataset.guestRemove=row.id;b.disabled=!!operation;host.appendChild(b);
    }
    function openRemoval(row){
      if(!admin()||!available||operation||!Number.isSafeInteger(row.version)||!Number.isSafeInteger(row.staff_version))return;
      var startOwner=owner,startEpoch=epoch,startToken=token;
      if(options.canOpen&&options.canOpen()===false)return;
      if(!admin()||!available||operation||owner!==startOwner||epoch!==startEpoch||token!==startToken)return;
      close();var restore=removed(row),name=[row.first_name,row.last_name].filter(Boolean).join(' ')||'this guest';
      dialog=doc.createElement('dialog');dialog.className='signup-dialog';dialog.dataset.guestRemoval='';dialog.setAttribute('aria-labelledby','guest-remove-title');var actionDialog=dialog;
      var title=doc.createElement('h2');title.id='guest-remove-title';title.textContent=(restore?'Restore guest visit for ':'Remove guest visit for ')+name+'?';dialog.appendChild(title);
      var note=doc.createElement('p');note.textContent=restore?'This restores the guest registration and its saved intake action. It does not send another welcome email or staff notification.':'This moves the registration to Removed visits and stops its intake follow-up. You can restore it later. Messages already sent cannot be recalled.';dialog.appendChild(note);
      var boundary=doc.createElement('p');boundary.className='signup-note';boundary.textContent='The person’s login, linked People record, membership history and any separate care plans stay in place. This removes the guest visit only.';dialog.appendChild(boundary);
      var footer=doc.createElement('footer'),cancel=button('Cancel',close),confirm=button(restore?'Restore guest visit':'Remove guest visit',function(){
        if(!admin()||!available||operation||owner!==startOwner||epoch!==startEpoch||dialog!==actionDialog)return;
        var id;try{id=root.crypto.randomUUID();}catch(_){options.notice('The secure request could not be created. Refresh before trying again.');return;}
        operation={owner:owner,epoch:epoch,busy:false,args:{p_request_id:id,p_id:row.id,p_version:row.version,p_staff_version:row.staff_version,p_lifecycle_version:row.guest_lifecycle_version,p_removed:!restore}};
        root.addEventListener('beforeunload',beforeUnload);close();run(operation);
      });confirm.className=restore?'':'danger';footer.append(cancel,confirm);dialog.appendChild(footer);dialog.addEventListener('cancel',function(e){e.preventDefault();close();});doc.body.appendChild(dialog);dialog.showModal();cancel.focus();
    }
    async function run(state){
      if(operation!==state||state.busy||!admin()||!available)return;
      state.busy=true;changed();
      try{
        if(options.ensureReady&&!await options.ensureReady(epoch))throw new Error('readiness');
        if(operation!==state||!admin()||state.owner!==owner||state.epoch!==epoch)throw new Error('readiness');
        var r=await deadline(options.db.rpc('set_guest_registration_removed',state.args));
        if(operation!==state||!identity())return;
        if(r.error){if(['22023','40001','42501'].includes(r.error.code)){operation=null;root.removeEventListener('beforeunload',beforeUnload);if(current())options.notice('This guest record changed or the action is no longer permitted. Refresh and review it before trying again.');await options.refresh();return;}throw new Error('unconfirmed');}
        var v=r.data;if(!v||v.id!==state.args.p_id||v.removed!==state.args.p_removed||v.lifecycle_version!==state.args.p_lifecycle_version+1)throw new Error('unconfirmed');
        operation=null;root.removeEventListener('beforeunload',beforeUnload);await options.refresh();
        if(current()&&state.owner===owner&&state.epoch===epoch)options.notice(state.args.p_removed?'Guest-visit removal recorded. The register now shows the current saved state. Linked People and care records were preserved.':'Guest-visit restoration recorded. The register now shows the current saved state. No new email was requested.');
      }catch(_){/* Preserve the exact request for an explicit idempotent retry. */}
      finally{if(operation===state)state.busy=false;if(identity())changed();}
    }
    function openSettings(){
      if(!admin()||!settings||operation)return;var startOwner=owner,startEpoch=epoch,startToken=token;
      if(options.canOpen&&options.canOpen()===false)return;
      if(!admin()||!settings||operation||owner!==startOwner||epoch!==startEpoch||token!==startToken)return;close();
      var version=settings.settings_version,initial=settings.sheet_url||'',saving=false,requiresRefresh=false,form=doc.createElement('form');
      dialog=doc.createElement('dialog');dialog.className='signup-dialog';dialog.dataset.guestSheet='';dialog.setAttribute('aria-labelledby','guest-sheet-title');
      form.innerHTML='<h2 id="guest-sheet-title">Guest spreadsheet</h2><p>Use the separate private guest register. The historical membership ledger is managed separately.</p><label>Google Sheets link<input name="sheet_url" type="url" required autocomplete="off"></label><p class="signup-note">Saving a link adds the Open guest spreadsheet button. Automatic updates require the approved spreadsheet sync to be configured separately.</p><p role="alert" data-sheet-error></p><footer><button type="button" class="quiet" data-sheet-close>Cancel</button><button type="submit">Save spreadsheet link</button></footer>';
      form.elements.sheet_url.value=initial;form.querySelector('[data-sheet-close]').onclick=function(){if(!saving)close();};
      form.onsubmit=async function(e){
        e.preventDefault();if(saving||requiresRefresh||!admin()||!settings||owner!==startOwner||epoch!==startEpoch||!dialog||!dialog.contains(form)||!form.reportValidity())return;
        var value=form.elements.sheet_url.value.trim();try{var u=new URL(value);u.search='';u.hash='';value=u.href;}catch(_){}
        if(!validUrl(value)){form.querySelector('[data-sheet-error]').textContent='Use a Google Sheets link ending in /edit.';return;}
        saving=true;form.querySelectorAll('input,button').forEach(function(n){n.disabled=true;});
        try{var r=await deadline(options.db.rpc('set_guest_sheet_settings',{p_version:version,p_sheet_url:value}));if(!current()||!dialog||!dialog.contains(form))return;if(r.error||!r.data||r.data.sheet_url!==value||r.data.settings_version!==version+1)throw new Error('unconfirmed');close();await load(epoch);if(current()&&owner===startOwner&&epoch===startEpoch)options.notice('Guest spreadsheet link saved. Check the spreadsheet for sync status.');}
        catch(_){requiresRefresh=true;if(current()&&dialog&&dialog.contains(form)){form.querySelector('[data-sheet-error]').textContent='The link save could not be confirmed. Close and refresh the register to check the saved link before editing again.';form.querySelector('[data-sheet-close]').disabled=false;}}
        finally{saving=false;}
      };
      dialog.appendChild(form);dialog.addEventListener('cancel',function(e){e.preventDefault();if(!saving)close();});doc.body.appendChild(dialog);dialog.showModal();form.elements.sheet_url.focus();
    }
    return {load:load,clear:clear,unavailable:unavailable,toolbar:toolbar,rowAction:rowAction,removed:removed,openRemoval:openRemoval};
  }
  root.CreekGuestRegisterTools={create:create};
}(typeof window!=='undefined'?window:globalThis));
