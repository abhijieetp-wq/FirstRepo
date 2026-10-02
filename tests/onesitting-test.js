// A customer, their address and the person who rang, in one press.
const fs=require('fs'), vm=require('vm');
const SRC='/home/user/FirstRepo/src';
let TABS={};
const sheetFor=name=>{ const t=TABS[name];
  return { getLastRow:()=>t.rows.length+1, getLastColumn:()=>t.headers.length, getName:()=>name,
    getRange:(r,c,nr,nc)=>({ getValues:()=>{ const R=(nr||1), C=(nc||t.headers.length);
        const all=[t.headers].concat(t.rows);
        return all.slice(r-1,r-1+R).map(row=>{ const o=(row||[]).slice(c-1,c-1+C);
          while(o.length<C) o.push(''); return o; }); },
      setValues:(v)=>{ if(r===1){ for(let j=0;j<v[0].length;j++) t.headers[c-1+j]=v[0][j];
          t.rows.forEach(row=>{while(row.length<t.headers.length) row.push('');}); return; }
        v.forEach((row,k)=>{ const i=r-2+k;
          while(t.rows.length<=i) t.rows.push(new Array(t.headers.length).fill(''));
          for(let j=0;j<row.length;j++) t.rows[i][c-1+j]=row[j]; }); },
      setFontWeight(){}, setValue(){} }),
    deleteRow:(r)=>{ t.rows.splice(r-2,1); },
    appendRow:(row)=>{ t.rows.push(row.slice()); } }; };
const sb={ console, Logger:{log(){}},
  LockService:{getScriptLock:()=>({waitLock(){},releaseLock(){},tryLock:()=>true})},
  PropertiesService:{getDocumentProperties:()=>({getProperty:()=>null,setProperty(){}}),
    getScriptProperties:()=>({getProperty:()=>null,setProperty(){}})},
  CacheService:{getUserCache:()=>({get:()=>null,put(){},remove(){}}),
    getScriptCache:()=>({get:()=>null,put(){},remove(){}})},
  SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:n=>TABS[n]?sheetFor(n):null})},
  Session:{getScriptTimeZone:()=>'Asia/Kolkata', getActiveUser:()=>({getEmail:()=>'x@pie.in'})},
  Utilities:{formatDate:()=>'2026-10-02', getUuid:(function(){let n=0;return()=>'u'+(++n);})()} };
vm.createContext(sb);
for (const f of ['Auth.gs','Schema.gs','SheetService.gs','StreamAccess.gs','SalesPolicy.gs',
                 'Pricing.gs','CompanyProfile.gs','Customers.gs'])
  vm.runInContext(fs.readFileSync(`${SRC}/${f}`,'utf8'), sb, {filename:f});
sb.getCurrentUser=()=>({email:'p@pie.in',name:'Priya',role:'Sales Coordinator',businessStream:'Spare Sales'});
sb.requireRole_=()=>{};

const H=n=>sb.SCHEMA[n].columns.slice();
let pass=0, fail=0;
const ok=(n,c,x)=>{ if(c) pass++; else { fail++; console.log('  FAIL: '+n+(x!==undefined?'   '+JSON.stringify(x):'')); } };
const err = fn => { try { fn(); return null; } catch(e){ return e.message; } };
const rows = t => TABS[t].rows;
const at=(n,f)=>{const i=H(n).indexOf(f); if(i===-1) throw new Error(n+' has no '+f); return i;};
const cell=(t,i,c)=>rows(t)[i][at(t,c)];

function seed() {
  if (sb.invalidateHeaders_) sb.invalidateHeaders_();
  TABS={};
  Object.keys(sb.SCHEMA).forEach(n=>{ TABS[n]={headers:H(n), rows:[]}; });
}

console.log('ONE PRESS, THREE RECORDS');
seed();
let c = sb.saveCustomerWithDetails({
  customer:{ name:'Plasflow Industries L.L.P', gstin:'27AAZFP3029R1Z6' },
  address:{ addressType:'Billing', line1:'Plot No. 44, Beside Durga Mandir',
            city:'Nagpur', state:'Maharashtra', pincode:'440008' },
  contact:{ name:'Mr Abhay Agrawal', phone:'9822737001', contactRole:'Purchase' }
});
ok('the customer exists', rows('Customers').length === 1, rows('Customers').length);
ok('and has a code', !!cell('Customers',0,'customerCode'), cell('Customers',0,'customerCode'));
ok('the address went in with it', rows('CustomerAddresses').length === 1);
ok('against that customer', cell('CustomerAddresses',0,'customerId') === c.id);
ok('and the contact too', rows('CustomerContacts').length === 1);
ok('against that customer as well', cell('CustomerContacts',0,'customerId') === c.id);

console.log('\nTHE FIRST OF EACH IS THE ONE EVERYTHING RESOLVES TO');
// An order that cannot find a default address is a dispatch that cannot be posted, and the
// coordinator who typed it is long gone by then.
ok('the address is the default', cell('CustomerAddresses',0,'isDefault') === 'TRUE',
  cell('CustomerAddresses',0,'isDefault'));
ok('the contact is primary', cell('CustomerContacts',0,'isPrimary') === 'TRUE',
  cell('CustomerContacts',0,'isPrimary'));

console.log('\nAND NOTHING IS INVENTED');
seed();
sb.saveCustomerWithDetails({ customer:{ name:'Walk-in' } });
ok('a customer on their own is fine', rows('Customers').length === 1);
ok('no empty address is stored', rows('CustomerAddresses').length === 0);
ok('no empty contact either', rows('CustomerContacts').length === 0);
// A block with everything but the first line is somebody who did not have it to hand.
seed();
sb.saveCustomerWithDetails({ customer:{ name:'Half' },
  address:{ city:'Nagpur', state:'Maharashtra' }, contact:{ phone:'9822737001' } });
ok('an address with no first line is not an address', rows('CustomerAddresses').length === 0);
ok('a contact with no name is not a contact', rows('CustomerContacts').length === 0);

console.log('\nAND A REFUSAL REFUSES THE WHOLE THING');
seed();
ok('a customer with no name is refused',
  !!err(()=>sb.saveCustomerWithDetails({ customer:{}, address:{ line1:'Somewhere' } })));
// The customer is written first because the others need its id, so a refusal there leaves
// nothing behind at all.
ok('and leaves no orphan address', rows('CustomerAddresses').length === 0);

console.log('\nTHE EXISTING WAY ROUND STILL WORKS');
seed();
c = sb.saveCustomerWithDetails({ customer:{ name:'Topworth Urja' } });
sb.saveCustomerAddress({ customerId:c.id, addressType:'Billing', line1:'Plot 6, MIDC Butibori',
  city:'Nagpur', isDefault:true });
ok('an address added afterwards still lands', rows('CustomerAddresses').length === 1);
sb.saveCustomerAddress({ customerId:c.id, addressType:'Billing', line1:'Second gate',
  city:'Nagpur', isDefault:true });
ok('and a second one can take over as default',
  cell('CustomerAddresses',0,'isDefault') === 'FALSE' &&
  cell('CustomerAddresses',1,'isDefault') === 'TRUE',
  [cell('CustomerAddresses',0,'isDefault'), cell('CustomerAddresses',1,'isDefault')]);

console.log('\n' + (fail ? 'FAILED ' + fail : 'all ' + pass + ' passed') + '  (' + pass + '/' + (pass+fail) + ')');
process.exit(fail ? 1 : 0);
