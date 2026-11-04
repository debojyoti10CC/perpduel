import { Clock } from 'lucide-react';
import { ROUND_DURATIONS } from '../../shared/types.ts';
import { OptionPicker } from './AssetPicker.jsx';

const ROUND_OPTIONS = ROUND_DURATIONS.map(seconds => {
  const minutes = seconds / 60;
  return { value: seconds, label: `${minutes} min`, name: `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}` };
});

export default function RoundDurationPicker({ value, onChange, label = 'Round length', className = '' }) {
  return <OptionPicker
    value={value}
    onChange={onChange}
    label={label}
    options={ROUND_OPTIONS}
    className={`round-duration-picker ${className}`}
    renderIcon={() => <Clock size={15} aria-hidden="true" />}
  />;
}
