/* Explicit weekly-email choices. Reads only; this module never sends a campaign. */
(function(root){
  'use strict';
  var labels={requested:'Requested weekly updates',not_requested:'No weekly updates',not_set:'No choice recorded',email_changed:'Email changed — new choice needed',account_unavailable:'Account unavailable',duplicate_email:'Shared email — review needed'};
  function create(options){
    var host=options.root,doc=host.ownerDocument,snapshot=null,mounted=false,owner=null,epoch=null,serial=0,busy=false,exporting=false,search='',filter='requested',message='';
    function context(){return options.getContext()||{};}
    function current(e,u){var c=context();return !!u&&c.userId===u&&c.epoch===e&&['admin','editor'].includes(c.role)&&c.canEdit===true&&c.workspaceReady!==false&&options.isCurrent(e);}
    function safe(v){var node=doc.createElement('span');node.textContent=v==null?'':String(v);return node.innerHTML.replace(/"/g,'&quot;');}
    function instant(v){return typeof v==='string'&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v));}
    function uuid(v){return typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);}
    function textValue(v,max){return typeof v==='string'&&Array.from(v).length<=max;}
    function valid(value){
      if(!value||value.version!==1||!instant(value.generated_at)||!Number.isSafeInteger(value.total)||value.total<0||value.total>5000||!Array.isArray(value.rows)||value.rows.length!==value.total)return false;
      var seen=new Set(),emails=new Map();
      if(!value.rows.every(function(r){
        if(!r||!uuid(r.id)||seen.has(r.id)||!textValue(r.first_name,100)||!textValue(r.last_name,100)||!textValue(r.email,320)||!r.email||!Object.hasOwn(labels,r.preference_status)||!Number.isSafeInteger(r.preference_version)||r.preference_version<0||r.updated_at!==null&&!instant(r.updated_at)||r.preference_status==='requested'&&(r.preference_version<1||r.updated_at===null||r.email!==r.email.trim()||/[\x00-\x1f\x7f]/.test(r.email)||!/^\S+@\S+\.\S+$/.test(r.email)))return false;
        seen.add(r.id);var key=r.email.toLowerCase();emails.set(key,(emails.get(key)||0)+1);return true;
      }))return false;
      return value.rows.every(function(r){return r.preference_status!=='requested'||emails.get(r.email.toLowerCase())===1;});
    }
    function clear(){serial++;snapshot=null;busy=false;exporting=false;mounted=false;owner=null;epoch=null;search='';filter='requested';message='';host.replaceChildren();}
    function mount(){
      if(mounted)return;
      host.innerHTML='<div class="comms-intro"><p class="eyebrow">Stay connected, by choice</p><h2>A place for this week’s news.</h2><p>See who has asked for weekly church emails. People can change their choice in the app. Personal welcome and care messages are separate.</p></div><div class="comms-stats" data-comms-stats></div><div class="comms-toolbar"><label>Search registrations<input type="search" data-comms-search placeholder="Name or email"></label><label>Show<select data-comms-filter><option value="requested">Requested weekly updates</option><option value="attention">Needs review</option><option value="all">All choices</option><option value="not_requested">No weekly updates</option><option value="not_set">No choice recorded</option></select></label><button type="button" class="quiet" data-comms-refresh>Refresh choices</button><button type="button" data-comms-export>Download weekly-email list</button></div><p role="status" class="comms-note" data-comms-status></p><div class="panel comms-list" data-comms-list></div><section class="panel comms-help"><h3>One current list. A clear next step.</h3><p>The download refreshes every choice first and includes only people who requested weekly emails, regardless of the search filter. It is a private spreadsheet copy, not a Google Sheets sync.</p><p>Weekly sending is not enabled here yet. Campaign review, unsubscribe links and bounced-address handling are the next steps. The list records a person’s choice; email ownership and delivery are not verified. A downloaded copy can become outdated when someone changes their choice.</p><a href="#signups">Open the guest register →</a></section>';
      host.querySelector('[data-comms-search]').value=search;host.querySelector('[data-comms-filter]').value=filter;
      host.querySelector('[data-comms-search]').oninput=function(e){search=e.target.value;render();};host.querySelector('[data-comms-filter]').onchange=function(e){filter=e.target.value;render();};
      host.querySelector('[data-comms-refresh]').onclick=function(){load(context().epoch);};host.querySelector('[data-comms-export]').onclick=download;
      mounted=true;var c=context();owner=c.userId;epoch=c.epoch;
    }
    function timeLabel(v){return new Date(v).toLocaleString('en-US',{timeZone:'America/Chicago',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})+' Central';}
    function attention(r){return ['email_changed','account_unavailable','duplicate_email'].includes(r.preference_status);}
    function render(){
      var c=context();if(!current(c.epoch,c.userId)||mounted&&(owner!==c.userId||epoch!==c.epoch)){clear();return;}mount();
      host.querySelector('[data-comms-refresh]').disabled=busy;host.querySelector('[data-comms-export]').disabled=busy||!snapshot||!snapshot.rows.some(function(r){return r.preference_status==='requested';});
      host.querySelector('[data-comms-status]').textContent=message;
      var stats=host.querySelector('[data-comms-stats]'),area=host.querySelector('[data-comms-list]');stats.replaceChildren();area.replaceChildren();if(!snapshot)return;
      var counts=[['Requested weekly emails',snapshot.rows.filter(function(r){return r.preference_status==='requested';}).length],['Need review',snapshot.rows.filter(attention).length],['Registrations checked',snapshot.total]];
      counts.forEach(function(item){var el=doc.createElement('article');el.innerHTML='<span>'+safe(item[0])+'</span><strong>'+item[1]+'</strong>';stats.appendChild(el);});
      var matches=snapshot.rows.filter(function(r){return (filter==='all'||filter==='attention'&&attention(r)||r.preference_status===filter)&&(!search.trim()||[r.first_name,r.last_name,r.email].join(' ').toLowerCase().includes(search.trim().toLowerCase()));});
      if(!matches.length){area.textContent='No registrations match this view.';return;}
      var table=doc.createElement('table');table.innerHTML='<caption>'+matches.length+' matching registrations'+(matches.length>100?' · Showing the first 100; narrow your search':'')+'</caption><thead><tr><th scope="col">Name</th><th scope="col">Account email</th><th scope="col">Weekly-email choice</th><th scope="col">Last choice</th></tr></thead><tbody></tbody>';
      matches.slice(0,100).forEach(function(r){var tr=doc.createElement('tr');tr.dataset.commsRow=r.id;tr.innerHTML='<td>'+safe(r.first_name+' '+r.last_name)+'</td><td>'+safe(r.email)+'</td><td>'+safe(labels[r.preference_status])+'</td><td>'+safe(r.updated_at?timeLabel(r.updated_at):'Not recorded')+'</td>';table.querySelector('tbody').appendChild(tr);});area.appendChild(table);
    }
    function deadline(promise){var timer;return Promise.race([promise,new Promise(function(_resolve,reject){timer=root.setTimeout(function(){reject(new Error('timeout'));},12000);})]).finally(function(){root.clearTimeout(timer);});}
    async function read(e,u,token){
      var result=await deadline(Promise.resolve().then(function(){return options.db.rpc('get_office_communication_audience',{});}));
      if(!current(e,u)||token!==serial)return null;
      if(result.error){if(result.error.code==='PGRST202')throw new Error('not_enabled');throw new Error('unavailable');}
      if(!valid(result.data))throw new Error('incomplete');
      // Retain only the contract fields even if a future server adds private data.
      return {version:1,generated_at:result.data.generated_at,total:result.data.total,rows:result.data.rows.map(function(r){return {id:r.id,first_name:r.first_name,last_name:r.last_name,email:r.email,preference_status:r.preference_status,preference_version:r.preference_version,updated_at:r.updated_at};})};
    }
    async function load(e){
      var u=context().userId;if(!current(e,u)){clear();return false;}if(mounted&&(owner!==u||epoch!==e))clear();if(exporting)return false;
      mount();var token=++serial;busy=true;snapshot=null;message='Refreshing saved communication choices…';render();
      try{var result=await read(e,u,token);if(!result)return false;snapshot=result;message='Choices checked '+timeLabel(result.generated_at)+'. Download refreshes them again.';return true;}
      catch(error){if(current(e,u)&&token===serial){snapshot=null;message=error.message==='not_enabled'?'Communication choices are not enabled on this service yet. The guest register and personal care continue separately.':'Communication choices could not refresh. No partial list or old download is available. Try Refresh choices.';}return false;}
      finally{if(token===serial){if(current(e,u)){busy=false;render();}else clear();}}
    }
    function cell(v){var s=String(v==null?'':v);if(/^[\s\uFEFF\x00-\x1f\x7f]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
    async function download(){
      var c=context(),e=c.epoch,u=c.userId;if(busy||!snapshot||!current(e,u))return;
      var token=++serial;busy=true;exporting=true;snapshot=null;message='Checking current choices before downloading…';render();
      try{
        if(options.ensureReady&&!await options.ensureReady(e))throw new Error('readiness');if(!current(e,u)||token!==serial)return;
        var result=await read(e,u,token);if(!result)return;snapshot=result;var rows=result.rows.filter(function(r){return r.preference_status==='requested';});
        if(!rows.length){message='The refreshed list has no requested weekly emails. No file was downloaded.';return;}
        var data=[['First name','Last name','Email (self-reported)','Weekly email choice','Choice version','Choice updated at (UTC)','Audience checked at (UTC)']].concat(rows.map(function(r){return [r.first_name,r.last_name,r.email,'Requested',r.preference_version,r.updated_at,result.generated_at];}));
        var csv='\uFEFF'+data.map(function(row){return row.map(cell).join(',');}).join('\r\n')+'\r\n';
        if(!current(e,u)||token!==serial)return;
        var blob=new root.Blob([csv],{type:'text/csv;charset=utf-8'}),url=root.URL.createObjectURL(blob),link=doc.createElement('a');link.href=url;link.download='creek-weekly-email-'+result.generated_at.slice(0,10)+'.csv';doc.body.appendChild(link);
        try{link.click();}finally{link.remove();root.setTimeout(function(){root.URL.revokeObjectURL(url);},1000);}
        message='Downloaded '+rows.length+' requested email'+(rows.length===1?'':'s')+', checked '+timeLabel(result.generated_at)+'. No messages were sent. Refresh before any later use.';
      }catch(error){if(current(e,u)&&token===serial){snapshot=null;message='The fresh list could not be confirmed. No file was downloaded. Refresh choices and try again.';}}
      finally{if(token===serial){if(current(e,u)){busy=false;exporting=false;render();}else clear();}}
    }
    return {load:load,render:render,clear:clear};
  }
  root.CreekCommunications={create:create};
}(typeof window!=='undefined'?window:globalThis));
