"""發現層考題評分（V8 §4.11 檢查三）：「哪張是事故表」與「欄位對照」的精確與召回，每家各報、合計報。
預測檔格式：{"tables": {表名: 類別}, "field_map": {事故表名: {"date": 欄名, "body_part": ..., "narrative": ..., "site": ...}}}
計分欄只算 date、body_part、narrative、site 四個（V8 §4.7 第 3 步）。
用法：python -I score_discovery.py ANSWERS.json PRED.json  （考題 answers 只在評分那天從 sealed zip 取出）
      python -I score_discovery.py --selftest   用開發種子 1003 自測：答案對答案要 1.0；簡單關鍵字基準要 < 1.0"""
import sys, json, pathlib, csv, re

KEYS = ['date', 'body_part', 'narrative', 'site']


def score(ans, pred):
    gold_inc = {t for t, c in ans['tables'].items() if c == 'incident'}
    pred_inc = {t for t, c in pred.get('tables', {}).items() if c == 'incident'}
    tp = len(gold_inc & pred_inc)
    t_p = tp / len(pred_inc) if pred_inc else 0.0
    t_r = tp / len(gold_inc) if gold_inc else 0.0
    gold_pairs = {(t, k, ans['field_map'][t][k]) for t in gold_inc for k in KEYS}
    pred_pairs = {(t, k, v) for t, m in pred.get('field_map', {}).items() for k, v in m.items() if k in KEYS and v}
    fp = len(gold_pairs & pred_pairs)
    return dict(table_precision=round(t_p, 3), table_recall=round(t_r, 3),
                field_precision=round(fp / len(pred_pairs), 3) if pred_pairs else 0.0, field_recall=round(fp / len(gold_pairs), 3),
                incident_tables=len(gold_inc), field_pairs=len(gold_pairs))


def keyword_baseline(folder):
    """便宜基準：有日期欄＋部位欄就算事故表；欄名關鍵字對照。"""
    pats = dict(date=r'date|dt|occur|evt', body_part=r'body|part|bp|anatom', narrative=r'happen|descr|narr|text|notes', site=r'site|plant|establish|facil|loc')
    pred = dict(tables={}, field_map={})
    for f in sorted(pathlib.Path(folder).glob('*.csv')):
        cols = next(csv.reader(open(f, encoding='utf-8')), [])
        name = f.stem.replace('__', '/').replace('-', ':', 1)
        m = {k: next((c for c in cols if re.search(p, c, re.I)), None) for k, p in pats.items()}
        pred['tables'][name] = 'incident' if m['date'] and m['body_part'] else 'other'
        if pred['tables'][name] == 'incident':
            pred['field_map'][name] = m
    return pred


if __name__ == '__main__':
    if sys.argv[1] == '--selftest':
        d = pathlib.Path(__file__).resolve().parents[1] / 'data' / 'composite' / '1003'
        ans = json.load(open(d / 'answers_PRIVATE.json', encoding='utf-8'))
        perfect = score(ans, ans)
        base = score(ans, keyword_baseline(d))
        print('answers-vs-answers', perfect)
        print('keyword-baseline  ', base)
        assert perfect['table_recall'] == perfect['field_recall'] == perfect['table_precision'] == perfect['field_precision'] == 1.0
        assert base['field_recall'] < 1.0
        print('selftest PASS')
    else:
        ans, pred = (json.load(open(p, encoding='utf-8')) for p in sys.argv[1:3])
        print(json.dumps(score(ans, pred)))
