import { useCallback, useEffect, useState } from 'react';
import { Button, Segmented, Spin } from 'antd';
import { api } from '../api/client';
import type { Item } from '../api/types';
import ItemCard from '../components/ItemCard';
import { useErrorToast } from '../lib/notify';

const PAGE = 60;

export default function Gallery() {
  const [filter, setFilter] = useState<'all' | 'fav'>('all');
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const toast = useErrorToast();

  const load = useCallback(async (before?: string, beforeId?: string) => {
    try {
      const list = await api.get<Item[]>('/api/gallery', { favorite: filter === 'fav' ? '1' : undefined, before, beforeId });
      const arr = Array.isArray(list) ? list : [];
      setItems((cur) => (before ? [...cur, ...arr.filter((x) => !cur.some((c) => c.id === x.id))] : arr));
      setHasMore(arr.length >= PAGE);
    } catch (e) { toast(e); }
  }, [filter, toast]);

  useEffect(() => {
    setLoading(true);
    setItems([]);
    load().finally(() => setLoading(false));
  }, [load]);

  const loadMore = async () => {
    const last = items[items.length - 1];
    if (!last?.createdAt) return;
    setMore(true);
    // (created_at, id) keyset cursor; dupes are still filtered in load() as a safety net.
    await load(new Date(last.createdAt).toISOString(), last.id);
    setMore(false);
  };

  return (
    <div className="page">
      <div className="page-hd">
        <h2>作品库</h2>
        <span>{items.length ? `${items.length}${hasMore ? '+' : ''} 张` : ''}</span>
        <div className="right">
          <Segmented value={filter} onChange={(v) => setFilter(v as 'all' | 'fav')} options={[{ value: 'all', label: '全部' }, { value: 'fav', label: '收藏' }]} />
        </div>
      </div>
      {loading ? (
        <div className="empty-state" style={{ height: 300 }}><Spin /></div>
      ) : !items.length ? (
        <div className="empty-state" style={{ height: 420 }}>
          <h3>{filter === 'fav' ? '还没有收藏的作品' : '作品库还是空的'}</h3>
          <p>{filter === 'fav' ? '在作品上点 ♡ 收藏，常用的图会集中在这里。' : '在项目里生成的图片都会自动收进这里。'}</p>
        </div>
      ) : (
        <>
          <div className="masonry">
            {items.map((it) => (
              <ItemCard
                key={it.id}
                item={it}
                onChange={(p) => setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, ...p } : x)).filter((x) => filter !== 'fav' || x.favorite))}
                onDeleted={() => setItems((xs) => xs.filter((x) => x.id !== it.id))}
              />
            ))}
          </div>
          {hasMore && (
            <div style={{ textAlign: 'center', marginTop: 12 }}>
              <Button onClick={loadMore} loading={more}>加载更多</Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
