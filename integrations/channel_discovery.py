"""Read-only model discovery through the local runner, with bounded network time."""
import httpx

def fetch_models(base,key,auth='bearer',transport=None):
    if auth not in ('bearer','anthropic'):raise ValueError('模型列表鉴权方式无效')
    headers={'Authorization':'Bearer '+key} if auth=='bearer' else {'x-api-key':key,'anthropic-version':'2023-06-01'}
    with httpx.Client(timeout=25,follow_redirects=False,trust_env=False,transport=transport) as client:
        r=client.get(base.rstrip('/')+'/models',headers=headers)
        if not r.is_success:
            raise ValueError('获取模型列表失败：HTTP '+str(r.status_code)+'。请检查地址、密钥权限和鉴权方式。')
        try:data=r.json()
        except ValueError:raise ValueError('模型列表接口没有返回 JSON')
        if isinstance(data,dict):
            if data.get('error') is not None:raise ValueError('模型列表接口返回错误；仍可手动填写模型 ID。')
            if 'data' in data:rows=data['data']
            elif 'models' in data:rows=data['models']
            else:raise ValueError('模型列表返回结构无法识别；仍可手动填写模型 ID。')
        else:rows=data
        if not isinstance(rows,list):raise ValueError('模型列表返回结构无法识别；仍可手动填写模型 ID。')
        ids=set()
        for row in rows:
            candidates=(row.get('id'),row.get('name')) if isinstance(row,dict) else (row,)
            value=next((v.strip() for v in candidates if isinstance(v,str) and v.strip()),None)
            if value is not None:ids.add(value)
        if rows and not ids:raise ValueError('模型列表没有可识别的模型 ID；仍可手动填写。')
        ids=sorted(ids)
        return {'models':ids,'total':len(ids)}
