import { useMemo, useState } from 'react';
import { App, Button, Input, Modal, Segmented, Spin } from 'antd';
import { PlusOutlined, UploadOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import type { Portrait } from '../api/types';
import { useModelLibrary } from '../lib/models';
import { useErrorToast } from '../lib/notify';
import PortraitCard from '../components/models/PortraitCard';
import AiModelCreate from '../components/models/AiModelCreate';
import UploadModelModal from '../components/models/UploadModelModal';

type Filter = 'all' | 'ai' | 'upload';

export default function ModelsLibrary() {
  const lib = useModelLibrary();
  const [filter, setFilter] = useState<Filter>('all');
  const [aiOpen, setAiOpen] = useState(false);
  const [upOpen, setUpOpen] = useState(false);
  const [renaming, setRenaming] = useState<Portrait | null>(null);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const { modal, message } = App.useApp();
  const toast = useErrorToast();

  const shown = useMemo(() => (filter === 'all' ? lib.list : lib.list.filter((p) => p.source === filter)), [lib.list, filter]);
  const counts = useMemo(() => ({
    ai: lib.list.filter((p) => p.source === 'ai').length,
    upload: lib.list.filter((p) => p.source === 'upload').length,
  }), [lib.list]);

  const openRename = (p: Portrait) => { setRenaming(p); setNewName(p.name); };
  const saveRename = async () => {
    if (!renaming) return;
    const n = newName.trim().slice(0, 30);
    if (!n) { message.warning('名称不能为空'); return; }
    if (n === renaming.name) { setRenaming(null); return; }
    setBusy(true);
    try {
      await api.patch(`/api/models-library/${renaming.id}`, { name: n });
      lib.patch(renaming.id, { name: n });
      setRenaming(null);
    } catch (e) { toast(e); } finally { setBusy(false); }
  };

  const remove = (p: Portrait) => {
    modal.confirm({
      title: `删除模特「${p.name}」？`,
      content: '删除后不能再选用，已生成的作品不受影响。',
      okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: async () => {
        try { await api.del(`/api/models-library/${p.id}`); lib.drop(p.id); message.success('已删除'); } catch (e) { toast(e); }
      },
    });
  };

  return (
    <div className="page">
      <div className="page-hd">
        <h2>模特库</h2>
        <span>{lib.list.length ? `${lib.list.length} 位模特` : ''}</span>
        <div className="right" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {lib.list.length > 0 && (
            <Segmented value={filter} onChange={(v) => setFilter(v as Filter)} options={[
              { value: 'all', label: '全部' },
              { value: 'ai', label: `AI 模特${counts.ai ? ` ${counts.ai}` : ''}` },
              { value: 'upload', label: `我的模特${counts.upload ? ` ${counts.upload}` : ''}` },
            ]} />
          )}
          <Button icon={<UploadOutlined />} onClick={() => setUpOpen(true)}>上传我的模特</Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setAiOpen(true)}>新建 AI 模特</Button>
        </div>
      </div>

      {lib.loading ? (
        <div className="empty-state" style={{ height: 300 }}><Spin /></div>
      ) : !lib.list.length ? (
        <div className="empty-state" style={{ height: 460 }}>
          <div className="art" aria-hidden><img src="/img/c-model.jpg" alt="" /><img src="/img/c-r2.jpg" alt="" /><img src="/img/c-r1.jpg" alt="" /></div>
          <h3>还没有模特</h3>
          <p>生成一位 AI 虚拟模特，或上传已授权的模特照片。保存后在详细模式里选用。</p>
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <Button icon={<UploadOutlined />} onClick={() => setUpOpen(true)}>上传我的模特</Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setAiOpen(true)}>新建 AI 模特</Button>
          </div>
        </div>
      ) : !shown.length ? (
        <div className="empty-state" style={{ height: 300 }}>
          <h3>{filter === 'ai' ? '还没有 AI 模特' : '还没有上传的模特'}</h3>
          <Button onClick={() => (filter === 'ai' ? setAiOpen(true) : setUpOpen(true))}>{filter === 'ai' ? '新建 AI 模特' : '上传我的模特'}</Button>
        </div>
      ) : (
        <div className="pt-grid">
          {shown.map((p) => <PortraitCard key={p.id} p={p} onRename={openRename} onDelete={remove} />)}
        </div>
      )}

      <AiModelCreate open={aiOpen} onClose={() => setAiOpen(false)} onSaved={lib.upsert} />
      <UploadModelModal open={upOpen} onClose={() => setUpOpen(false)} onSaved={lib.upsert} />
      <Modal title="重命名模特" open={!!renaming} onCancel={() => setRenaming(null)} onOk={saveRename} okText="保存" cancelText="取消"
        confirmLoading={busy} width={380} destroyOnHidden>
        <Input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={30} onPressEnter={saveRename} autoFocus style={{ marginTop: 8 }} />
      </Modal>
    </div>
  );
}
