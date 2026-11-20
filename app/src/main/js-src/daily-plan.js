
// Daily plan is an ordered, dated selection of existing task IDs.
// It never moves cards, changes task priorities, or rewrites deadlines.
// Preserve existing daily-plan records across application upgrades.
const COMRADE_DAY_KEY = 'comrade_day_plan_v1';
const dayPlanEl = id => document.getElementById(id);
const dayPlanTasks = () => Object.values(state._tasksByBoard).flat();
function dayPlanNotice(message) {
  const item=document.createElement('div');
  item.className='day-plan-notice';
  item.textContent=String(message);
  const log=dayPlanEl('dayPlanLog');
  if(log){log.appendChild(item);log.scrollTop=log.scrollHeight;}
}
function bindDailyPlan() {
  dayPlanEl('dayPlanClose').onclick=()=>{dayPlanEl('dayPlanPanel').hidden=true;};
}

function comradeDayCandidates(today = todayISO()) {
  const boards = new Map(state.boards.map(board => [board.id, board]));
  return dayPlanTasks().flatMap(task => {
    if (task.parentId) return []; // Avoid listing the same work twice via parent and child.
    const board = boards.get(task.boardId);
    if (!board) return [];
    const index = board.columns.findIndex(c => c.id === task.columnId);
    if (index < 0 || board.columns[index].isDone) return [];
    const priorityValue = PRIORITY_ORDER[task.priority] || 0;
    const inProgress = index > 0;
    let rank = 0, reason = '';
    if (task.deadline && task.deadline < today) {
      rank = 500; reason = 'Просрочено';
    } else if (task.deadline === today) {
      rank = 400; reason = 'Срок сегодня';
    } else if (inProgress) {
      rank = 300; reason = 'В работе';
    } else if (!task.deadline && task.priority === 'high') {
      rank = 250; reason = 'Важная без срока';
    } else if (task.deadline && task.priority === 'high') {
      const target = new Date(today + 'T12:00:00');
      target.setDate(target.getDate() + 1);
      const tomorrow = [
        target.getFullYear(),
        String(target.getMonth()+1).padStart(2,'0'),
        String(target.getDate()).padStart(2,'0')
      ].join('-');
      if (task.deadline === tomorrow) { rank = 200; reason = 'Высокий приоритет · завтра'; }
    }
    // Keep all remaining unfinished top-level tasks selectable too.
    // Their low score keeps them out of the default six-task suggestion.
    if (!rank) {
      rank = task.deadline ? 90 : 50;
      reason = task.deadline ? 'Позднее' : 'Без срока';
    }
    return [{
      id: task.id, title: task.title, board: board.name, boardId: board.id,
      priority: task.priority || 'none', deadline: task.deadline || '',
      reason, score: rank + priorityValue * 10
    }];
  }).sort((a,b) =>
    b.score - a.score ||
    (a.deadline || '9999-12-31').localeCompare(b.deadline || '9999-12-31') ||
    a.title.localeCompare(b.title,'ru') || a.id.localeCompare(b.id)
  ).slice(0,60);
}

function comradeDayDraft(candidates, saved, today = todayISO(), fresh = false) {
  const valid = new Map(candidates.map(item => [item.id,item]));
  const savedIds = !fresh && saved?.date === today && Array.isArray(saved.ids)
    ? [...new Set(saved.ids.filter(id => typeof id === 'string'))] : [];
  const rows = [
    ...savedIds.filter(id => valid.has(id)).map(id => valid.get(id)),
    ...candidates.filter(item => !savedIds.includes(item.id))
  ];
  const availableSaved = savedIds.filter(id => valid.has(id));
  const selected = availableSaved.length && !fresh
    ? availableSaved : rows.slice(0,6).map(item => item.id);
  return {rows, selected, fromSaved:saved?.date===today && availableSaved.length>0 && !fresh};
}

// Commit only an ordered list of existing task IDs into the separate settings store.
async function comradePersistDay(ids, date = todayISO()) {
  if (date !== todayISO()) throw new Error('Начался новый день; обнови план.');
  const eligible = new Set(comradeDayCandidates(date).map(task => task.id));
  const validIds = [...new Set(ids)].filter(id => eligible.has(id));
  if (!validIds.length) throw new Error('Нет выбранных незавершённых задач.');
  await dbPutSettingsBulk([[COMRADE_DAY_KEY, {
    date, ids:validIds, updatedAt:Date.now()
  }]]);
  return validIds;
}

async function comradeOpenDailyPlan({fresh = false} = {}) {
  const panel=dayPlanEl('dayPlanPanel');
  panel.hidden=false;
  dayPlanEl('dayPlanLog').replaceChildren();
  const today=todayISO();
  let saved;
  try {
    const settings = await dbGetSettings();
    saved = settings[COMRADE_DAY_KEY];
  } catch(e) {
    dayPlanNotice('Не удалось прочитать план: ' + (e.message || e)); return;
  }
  if (panel.hidden) return;
  const candidates = comradeDayCandidates(today);
  if (!candidates.length) {
    dayPlanNotice('На ' + today + ' нет незавершённых просроченных, сегодняшних ' +
      'или высокоприоритетных задач. Проверил все ' + state.boards.length + ' доски.');
    return;
  }
  const draft = comradeDayDraft(candidates,saved,today,fresh);
  const rows = draft.rows.slice();
  const selected = new Set(draft.selected);
  const entry = document.createElement('section');
  entry.className = 'day-plan-card';
  const title = document.createElement('strong');
  title.textContent = (draft.fromSaved?'Сохранённый план':'Предложенный план') +
    ' на ' + today;
  const note = document.createElement('p');
  note.className = 'day-plan-note';
  note.textContent = 'Все ' + state.boards.length + ' доски · ' + candidates.length +
    ' незавершённых задач. Сначала просроченные, сегодняшние и важные. ' +
    'Остальные тоже можно выбрать. Измени порядок стрелками.' +
    (candidates.length >= 60 ? ' Показаны первые 60 задач по срочности.' : '');
  const list = document.createElement('div');
  list.className = 'day-plan-list';
  const footer = document.createElement('div');
  footer.className = 'day-plan-actions';
  const control = (text,klass='btn btn-secondary btn-small')=>{
    const button=document.createElement('button');
    button.type='button';button.className=klass;button.textContent=text;
    footer.appendChild(button);return button;
  };
  const save=control('Сохранить в «Мой день»','btn btn-small');
  const rebuild=control('Новый вариант');
  const close=control('Закрыть');
  entry.append(title,note,list,footer);
  dayPlanEl('dayPlanLog').appendChild(entry);
  entry.scrollIntoView({block:'nearest'});
  function redraw() {
    list.replaceChildren();
    rows.forEach((item,index)=>{
      const row=document.createElement('div');row.className='day-plan-row';
      const label=document.createElement('label');label.className='day-plan-description';
      const check=document.createElement('input');check.type='checkbox';
      check.checked=selected.has(item.id);
      check.setAttribute('aria-label','Включить в план: '+item.title);
      check.onchange=()=>{if(check.checked)selected.add(item.id);else selected.delete(item.id);redraw();};
      const details=document.createElement('span');
      const name=document.createElement('strong');name.textContent=item.title;
      const meta=document.createElement('small');
      const priority={high:'высокий',medium:'средний',low:'низкий',none:'нет'}[item.priority]||'нет';
      meta.textContent=item.board+' · '+item.reason+' · приоритет: '+priority+
        (item.deadline?' · до '+item.deadline:'');
      details.append(name,meta);
      label.append(check,details);
      const arrows=document.createElement('div');arrows.className='day-plan-arrows';
      const makeArrow=(symbol,move,disabled)=>{
        const button=document.createElement('button');
        button.type='button';button.className='btn btn-ghost btn-small';
        button.textContent=symbol;button.disabled=disabled;
        button.setAttribute('aria-label',(move<0?'Переместить выше: ':'Переместить ниже: ')+item.title);
        button.onclick=()=>{
          const other=index+move;
          [rows[index],rows[other]]=[rows[other],rows[index]];
          redraw();
        };
        arrows.appendChild(button);
      };
      makeArrow('↑',-1,index===0);
      makeArrow('↓',1,index===rows.length-1);
      row.append(label,arrows);
      list.appendChild(row);
    });
    save.textContent='Сохранить в «Мой день» ('+selected.size+')';
    save.disabled=!selected.size;
  }
  redraw();
  save.onclick=async()=>{
    const ids=rows.filter(item=>selected.has(item.id)).map(item=>item.id);
    save.disabled=true;
    try {
      const persisted=await comradePersistDay(ids,today);
      title.textContent='Сохранённый план на '+today;
      dayPlanNotice('Сохранено '+persisted.length+' задач в «Мой день» по всем доскам. '+
        'Их сроки, статусы, приоритеты и доски не изменены.');
    } catch(e){dayPlanNotice('Ошибка сохранения плана: '+(e.message||e));}
    finally{redraw();}
  };
  rebuild.onclick=()=>{entry.remove();void comradeOpenDailyPlan({fresh:true});};
  close.onclick=()=>{panel.hidden=true;};
}
