/**
 * 농가 평가체계 AHP 설문 — 응답 수집 및 결과 계산 (Google Apps Script)
 *
 * 응답:  설문 홈페이지가 보낸 응답을 '응답' 시트에 평가자 번호별로 한 줄씩 저장합니다.
 *        같은 평가자 번호로 다시 제출하면 그 줄을 덮어씁니다.
 * 결과:  시트 상단 메뉴 [AHP] > [결과 계산]을 누르면 아래 세 시트를 새로 씁니다.
 *        - 종합중요도 : 모든 항목의 상위 항목 안 비중과 최종 가중치(통합·평가자별), 최하위 요소 순위
 *        - 세부결과   : 비교 묶음별 쌍대비교 값, 결과 중요도, 비일관성 비율(통합·평가자별),
 *                       Super Decisions 입력용 통합 쌍대비교 행렬
 *        - 민감도     : 1계층(부문) 가중치 ±10% 시 최하위 요소의 최종 가중치·순위와 MAD
 *
 * TREE는 index.html의 TREE와 똑같아야 합니다.
 */

const TREE = {id:"G", name:"농가 단위 가치 평가", children:[
  {id:"E", name:"환경", children:[{id:"E1",name:"토양"},{id:"E2",name:"수질"},{id:"E3",name:"대기"},{id:"E4",name:"생태"}]},
  {id:"S", name:"사회", children:[{id:"S1",name:"인적 기반"},{id:"S2",name:"영농 활동 기반"},{id:"S3",name:"지역사회 기반"}]},
  {id:"C", name:"경제", children:[{id:"C1",name:"수익성"},{id:"C2",name:"생산성"},{id:"C3",name:"안정성"}]},
]};
const CR_LIMIT = 0.1;     // 비일관성 비율 기준
const SHOCK = 0.1;        // 민감도 분석 충격 크기(±10%)
const RESP_SHEET = "응답";

const RI = [0,0,0,0.58,0.90,1.12,1.24,1.32,1.41,1.45,1.49,1.51,1.48,1.56,1.57,1.59];

/* ---------- 계층 ---------- */
const NODES = {}, ORDER = [];
(function walk(n, parent, depth){ n.parent=parent; n.depth=depth; NODES[n.id]=n; ORDER.push(n); (n.children||[]).forEach(c=>walk(c,n,depth+1)); })(TREE,null,0);
const GROUPS = ORDER.filter(n=>n.children && n.children.length>=2).map(n=>({id:n.id, node:n, items:n.children.map(c=>c.name)}));
const LEAVES = ORDER.filter(n=>!n.children);

/* ---------- AHP 계산 (설문 화면과 같은 식) ---------- */
function pairs(n){ const p=[]; for(let i=0;i<n;i++) for(let j=i+1;j<n;j++) p.push([i,j]); return p; }
function sToA(s){ return s<9 ? 10-s : s===9 ? 1 : 1/(s-8); }
function matrixFrom(n, getA){ const A=[]; for(let i=0;i<n;i++){ A.push([]); for(let j=0;j<n;j++) A[i].push(1); } pairs(n).forEach(([i,j])=>{ const a=getA(i,j); A[i][j]=a; A[j][i]=1/a; }); return A; }
function analyze(A){
  const n=A.length;
  const gm=A.map(r=>Math.pow(r.reduce((x,y)=>x*y,1),1/n));
  const s=gm.reduce((x,y)=>x+y,0), w=gm.map(g=>g/s);
  const Aw=A.map(r=>r.reduce((acc,v,j)=>acc+v*w[j],0));
  const lam=Aw.reduce((acc,v,i)=>acc+v/w[i],0)/n;
  const CI=n>2?(lam-n)/(n-1):0, CR=n>2?Math.max(0,CI/RI[n]):0;
  return {w:w, lam:lam, CI:CI, CR:CR};
}
function groupResult(g, gs){
  if(!gs || !gs.s) return null;
  const n=g.items.length;
  if(!pairs(n).every(([i,j])=>gs.s[i+"-"+j])) return null;
  const A=matrixFrom(n,(i,j)=>sToA(gs.s[i+"-"+j]));
  const r=analyze(A); r.A=A; return r;
}
/* 묶음별 지역 가중치(local) → 모든 항목의 최종 가중치(global) */
function rollUp(localByGroup){
  const local={}, global={}; global[TREE.id]=1;
  ORDER.forEach(n=>{ if(!n.children) return;
    const lw = n.children.length===1 ? [1] : (localByGroup[n.id] ? localByGroup[n.id].w : null);
    n.children.forEach((c,i)=>{ local[c.id]= lw ? lw[i] : NaN; global[c.id]=global[n.id]*local[c.id]; });
  });
  return {local:local, global:global};
}
function ranks(values){ // 큰 값이 1위, 계산할 수 없는 값은 순위 없음
  const ok=values.map((v,i)=>i).filter(i=>isFinite(values[i]));
  ok.sort((a,b)=>values[b]-values[a]); const r=values.map(()=>""); ok.forEach((i,k)=>r[i]=k+1); return r;
}

/* ---------- 응답 받기 ---------- */
function header_(){
  const h=["평가자 번호","제출 시각"];
  GROUPS.forEach(g=>{ pairs(g.items.length).forEach(([i,j])=>h.push(g.node.name+": "+g.items[i]+" vs "+g.items[j]+" (a_ij)")); h.push(g.node.name+": CR", g.node.name+": 수정요청 후 유지"); });
  h.push("원자료(JSON)");
  return h;
}
function evaluatorOf_(p){ return String(p.evaluator || p.name || p.token || "").trim(); }

function doPost(e){
  const lock=LockService.getScriptLock(); lock.waitLock(20000);
  try{
    const p=JSON.parse(e.postData.contents);
    const id=evaluatorOf_(p);
    if(!id) throw new Error("평가자 번호가 없습니다");
    const ss=SpreadsheetApp.getActiveSpreadsheet();
    let sh=ss.getSheetByName(RESP_SHEET); if(!sh) sh=ss.insertSheet(RESP_SHEET);
    const head=header_();
    if(sh.getLastRow()===0){ sh.appendRow(head); sh.setFrozenRows(1); }
    else sh.getRange(1,1,1,head.length).setValues([head]);

    const row=[id, new Date()];
    GROUPS.forEach(g=>{ const gs=p.groups&&p.groups[g.id], r=groupResult(g,gs);
      pairs(g.items.length).forEach(([i,j])=>row.push(r?Number(r.A[i][j].toFixed(4)):""));
      row.push(r&&g.items.length>2?Number(r.CR.toFixed(4)):"", gs&&gs.override?"Y":""); });
    row.push(JSON.stringify(p));

    const last=sh.getLastRow(); let target=0;
    if(last>1){ const ids=sh.getRange(2,1,last-1,1).getValues(); for(let k=0;k<ids.length;k++) if(String(ids[k][0]).trim()===id){ target=k+2; break; } }
    if(target) sh.getRange(target,1,1,row.length).setValues([row]); else sh.appendRow(row);
    return ContentService.createTextOutput(JSON.stringify({ok:true})).setMimeType(ContentService.MimeType.JSON);
  }catch(err){
    return ContentService.createTextOutput(JSON.stringify({ok:false,error:String(err)})).setMimeType(ContentService.MimeType.JSON);
  }finally{ lock.releaseLock(); }
}
function doGet(){ return ContentService.createTextOutput("AHP 설문 수집기가 작동 중입니다."); }

/* ---------- 메뉴 ---------- */
function onOpen(){
  SpreadsheetApp.getUi().createMenu("AHP")
    .addItem("결과 계산","computeResults")
    .addItem("응답 코드 불러오기","importCode")
    .addToUi();
}

function readResponses_(){
  const sh=SpreadsheetApp.getActiveSpreadsheet().getSheetByName(RESP_SHEET);
  if(!sh || sh.getLastRow()<2) return [];
  const lastCol=sh.getLastColumn();
  const vals=sh.getRange(2,1,sh.getLastRow()-1,lastCol).getValues();
  return vals.map(r=>{ try{ const p=JSON.parse(r[lastCol-1]); p.id=evaluatorOf_(p); return p; }catch(e){ return null; } })
             .filter(p=>p && p.id && GROUPS.every(g=>groupResult(g,p.groups&&p.groups[g.id])));
}

/* ---------- 결과 계산 ---------- */
function analyzeAll_(list){
  // 평가자별
  const persons=list.map(p=>{
    const res={}; GROUPS.forEach(g=>res[g.id]=groupResult(g,p.groups[g.id]));
    return {id:p.id, res:res, w:rollUp(res), override:GROUPS.filter(g=>p.groups[g.id].override).map(g=>g.id)};
  });
  // 통합: 묶음마다 CR 기준 통과자의 기하평균
  const agg={};
  GROUPS.forEach(g=>{
    const n=g.items.length;
    const used=persons.filter(x=>n<=2 || x.res[g.id].CR<=CR_LIMIT);
    if(!used.length){ agg[g.id]=null; return; }
    const A=matrixFrom(n,(i,j)=>Math.exp(used.reduce((acc,x)=>acc+Math.log(x.res[g.id].A[i][j]),0)/used.length));
    const r=analyze(A); r.A=A; r.used=used.map(x=>x.id); agg[g.id]=r;
  });
  return {persons:persons, agg:agg, aggW:rollUp(agg)};
}

function writeSheet_(name, rows){
  const ss=SpreadsheetApp.getActiveSpreadsheet();
  let sh=ss.getSheetByName(name); if(!sh) sh=ss.insertSheet(name); else sh.clear();
  const W=Math.max.apply(null, rows.map(r=>r.length).concat([1]));
  const out=rows.map(r=>{ const x=r.map(v=>v===undefined||v===null||(typeof v==="number"&&!isFinite(v))?"":v); while(x.length<W) x.push(""); return x; });
  if(out.length) sh.getRange(1,1,out.length,W).setValues(out);
  sh.setFrozenColumns(1);
  return sh;
}
const r5 = x => (typeof x==="number" && isFinite(x)) ? Number(x.toFixed(5)) : "";
const indent = n => "　".repeat(Math.max(0,(n.depth-1)*2)) + n.name;

function computeResults(){
  const list=readResponses_();
  if(!list.length){ SpreadsheetApp.getUi().alert("완료된 응답이 없습니다."); return; }
  const R=analyzeAll_(list), P=R.persons, ids=P.map(x=>x.id);

  /* 1) 종합중요도 */
  const s1=[];
  s1.push(["계산 시각", new Date()]);
  s1.push(["평가자 수", P.length, "통합 방식", "비교 묶음별로 비일관성 비율 "+CR_LIMIT+" 이하인 평가자 응답의 기하평균"]);
  s1.push([]);
  s1.push(["최하위 요소의 통합결과 순위"]);
  s1.push(["순위","요소","상위 항목","최종 가중치"]);
  const leafG=LEAVES.map(n=>R.aggW.global[n.id]), leafRank=ranks(leafG);
  const missing=GROUPS.filter(g=>!R.agg[g.id]).map(g=>g.node.name);
  if(missing.length) s1.push(["※ 기준을 통과한 응답이 없는 비교 묶음: "+missing.join(", ")+" — 해당 요소의 통합 가중치를 계산할 수 없습니다."]);
  LEAVES.map((n,i)=>({n:n,g:leafG[i],r:leafRank[i]})).sort((a,b)=>(a.r||1e9)-(b.r||1e9))
    .forEach(x=>s1.push([x.r, x.n.name, x.n.parent.name, r5(x.g)]));
  s1.push([]);
  s1.push(["항목별 중요도 — 상위 항목 안 비중(local)"]);
  s1.push(["항목","통합결과"].concat(ids));
  ORDER.slice(1).forEach(n=>s1.push([indent(n), r5(R.aggW.local[n.id])].concat(P.map(x=>r5(x.w.local[n.id])))));
  s1.push([]);
  s1.push(["항목별 중요도 — 최종 가중치(global) = 상위 항목의 최종 가중치 × 상위 항목 안 비중"]);
  s1.push(["항목","통합결과"].concat(ids));
  ORDER.slice(1).forEach(n=>s1.push([indent(n), r5(R.aggW.global[n.id])].concat(P.map(x=>r5(x.w.global[n.id])))));
  s1.push(["최하위 요소 합계", r5(LEAVES.reduce((a,n)=>a+R.aggW.global[n.id],0))].concat(P.map(x=>r5(LEAVES.reduce((a,n)=>a+x.w.global[n.id],0)))));
  s1.push([]);
  s1.push(["비일관성 비율(CR) — 기준 "+CR_LIMIT+" 이하, * 는 수정 요청 후 응답을 유지한 경우"]);
  s1.push(["비교 묶음","통합결과","통과 인원"].concat(ids));
  GROUPS.forEach(g=>{ const a=R.agg[g.id];
    s1.push([g.node.name, g.items.length>2&&a?r5(a.CR):"-", a?a.used.length+"/"+P.length:"0/"+P.length]
      .concat(P.map(x=>g.items.length>2 ? x.res[g.id].CR.toFixed(4)+(x.res[g.id].CR>CR_LIMIT?" 탈락":"")+(x.override.indexOf(g.id)>=0?" *":"") : "-"))); });
  writeSheet_("종합중요도", s1);

  /* 2) 세부결과 */
  const s2=[];
  GROUPS.forEach(g=>{ const a=R.agg[g.id], n=g.items.length;
    s2.push([g.node.name + (g.node.parent ? "" : " (1계층)")]);
    s2.push(["요소별 평가 값 (a_ij)","통합결과"].concat(ids));
    pairs(n).forEach(([i,j])=>s2.push([g.items[i]+" — "+g.items[j], a?r5(a.A[i][j]):""].concat(P.map(x=>r5(x.res[g.id].A[i][j])))));
    s2.push(["※ 1보다 크면 왼쪽 요소가, 1보다 작으면 오른쪽 요소가 더 중요함을 뜻합니다."]);
    s2.push(["결과 중요도"]);
    g.items.forEach((it,i)=>s2.push([it, a?r5(a.w[i]):""].concat(P.map(x=>r5(x.res[g.id].w[i])))));
    if(n>2) s2.push(["비일관성 비율", a?r5(a.CR):""].concat(P.map(x=>r5(x.res[g.id].CR))));
    if(a){
      s2.push(["통합 쌍대비교 행렬 (Super Decisions 입력용, 행 요소가 열 요소보다 a배 중요)"].concat(g.items));
      g.items.forEach((it,i)=>s2.push([it].concat(g.items.map((_,j)=>r5(a.A[i][j])))));
      s2.push(["통합에 포함된 평가자", a.used.join(", ")]);
    }
    s2.push([]);
  });
  writeSheet_("세부결과", s2);

  /* 3) 민감도: 1계층 요소 가중치 ±SHOCK, 나머지는 비율대로 조정 */
  const s3=[];
  const top=TREE.children, base=R.aggW.local;
  if(R.agg[TREE.id]){
    const scen=[];
    top.forEach((t,ti)=>[+1,-1].forEach(sign=>{
      const wt=base[t.id]*(1+sign*SHOCK), rest=1-base[t.id];
      const newTop={}; top.forEach(o=>newTop[o.id]= o.id===t.id ? wt : base[o.id]*(1-wt)/rest);
      const loc=Object.assign({}, base, newTop);
      const glob={}; glob[TREE.id]=1; ORDER.slice(1).forEach(n=>glob[n.id]=glob[n.parent.id]*loc[n.id]);
      scen.push({label:t.name+(sign>0?" +":" -")+Math.round(SHOCK*100)+"%", top:newTop, g:LEAVES.map(n=>glob[n.id])});
    }));
    scen.forEach(s=>s.r=ranks(s.g));
    s3.push(["민감도 분석 — 1계층 요소의 가중치를 ±"+Math.round(SHOCK*100)+"% 바꾸고, 나머지 1계층 요소는 원래 비율대로 조정"]);
    s3.push([]);
    s3.push(["1계층 가중치","기본"].concat(scen.map(s=>s.label)));
    top.forEach(t=>s3.push([t.name, r5(base[t.id])].concat(scen.map(s=>r5(s.top[t.id])))));
    s3.push([]);
    s3.push(["최하위 요소 순위","기본 순위"].concat(scen.map(s=>s.label)).concat(["MAD"]));
    const order=LEAVES.map((n,i)=>i).sort((a,b)=>(leafRank[a]||1e9)-(leafRank[b]||1e9));
    order.forEach(i=>{ const mad=leafRank[i]===""?"":Number((scen.reduce((a,s)=>a+Math.abs(s.r[i]-leafRank[i]),0)/scen.length).toFixed(2));
      s3.push([LEAVES[i].name, leafRank[i]].concat(scen.map(s=>s.r[i])).concat([mad])); });
    s3.push(["MAD = 시나리오별 순위와 기본 순위 차이의 절댓값 평균 (작을수록 순위가 안정적)"]);
    s3.push([]);
    s3.push(["최하위 요소 최종 가중치","기본"].concat(scen.map(s=>s.label)));
    order.forEach(i=>s3.push([LEAVES[i].name, r5(leafG[i])].concat(scen.map(s=>r5(s.g[i])))));
  } else s3.push(["1계층 비교에서 기준을 통과한 응답이 없어 민감도 분석을 할 수 없습니다."]);
  writeSheet_("민감도", s3);

  SpreadsheetApp.getUi().alert("결과를 갱신했습니다 (평가자 "+P.length+"명). '종합중요도', '세부결과', '민감도' 시트를 확인하세요.");
}

/* 네트워크 문제로 '응답 코드'를 받은 경우 시트에 추가 */
function importCode(){
  const ui=SpreadsheetApp.getUi();
  const r=ui.prompt("응답 코드 불러오기","AHP2: 로 시작하는 코드를 붙여 넣으세요",ui.ButtonSet.OK_CANCEL);
  if(r.getSelectedButton()!==ui.Button.OK) return;
  const t=r.getResponseText().trim();
  if(!/^AHP\d:/.test(t)){ ui.alert("코드 형식이 올바르지 않습니다."); return; }
  const p=JSON.parse(Utilities.newBlob(Utilities.base64Decode(t.slice(5))).getDataAsString("UTF-8"));
  const out=JSON.parse(doPost({postData:{contents:JSON.stringify(p)}}).getContent());
  ui.alert(out.ok ? "평가자 "+evaluatorOf_(p)+"의 응답을 추가했습니다." : "추가하지 못했습니다: "+out.error);
}
